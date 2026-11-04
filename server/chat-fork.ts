import { captureChatCopy, restoreChatCopy } from './chat-copy.js';
import { createHash } from 'node:crypto';
import { chatTitle, fields, HttpError, record, text } from './request-validation.js';
import type { Chat, Store } from './store.js';

function numberedCopyTitle(store: Store, title: string): string {
  // Match suffix runs once from left to right; an end-anchored repetition can
  // repeatedly rescan long titles that contain suffixes inside their text.
  const base =
    title.replace(/(?: · (?:새 이야기|사본 [1-9]\d*)| \(사본(?: [1-9]\d*)?\))+/gu, (run, offset) =>
      offset + run.length === title.length ? '' : run
    ) || title;
  let last = 0;
  for (const row of store.db.prepare('SELECT title FROM chats').all()) {
    const existing = String(row.title);
    const match = existing.match(/(?: · 사본 ([1-9]\d*)| \(사본 ([1-9]\d*)\))$/u);
    if (!match) continue;
    const prefix = existing.slice(0, match.index);
    const legacyMatch =
      base.length <= 200 &&
      existing.length === 200 &&
      prefix === base.slice(0, 200 - match[0].length);
    if (prefix !== base && !legacyMatch) continue;
    const number = Number(match[1] ?? match[2]);
    if (Number.isSafeInteger(number)) last = Math.max(last, number);
  }
  const suffix = ` (사본 ${last + 1})`;
  return base + suffix;
}

/** A fork is a new chat with copied user data, not a shared execution/snapshot graph. */
export function forkChat(store: Store, chatId: string, value: unknown): Chat {
  const body = record(value);
  fields(body, ['fromRevision', 'title', 'idempotencyKey']);
  const sourceId = body.fromRevision === null ? null : text(body.fromRevision, 'source ID', 100);
  const requestKey = text(body.idempotencyKey, 'copy request', 100);
  const requestedTitle = body.title === undefined ? null : chatTitle(body.title);
  const command = createHash('sha256')
    .update(JSON.stringify({ chatId, sourceId, title: requestedTitle }))
    .digest('hex');
  return store.transaction(() => {
    const receiptKey = `transcript:copy:${requestKey}`;
    const row = store.db
      .prepare('SELECT result FROM import_operations WHERE key=?')
      .get(receiptKey);
    const saved = row
      ? (JSON.parse(String(row.result)) as {
          chatId: string;
          automaticCopyTitle?: string;
          forkCommand?: string;
        })
      : undefined;
    const rememberCommand = () =>
      store.db
        .prepare(
          "UPDATE import_operations SET result=json_set(result,'$.forkCommand',?) WHERE key=?"
        )
        .run(command, receiptKey);
    const conflict = () => {
      throw new HttpError(409, '다른 채팅에 같은 가져오기 ID가 사용됐어요.');
    };
    if (saved?.forkCommand) {
      if (saved.forkCommand !== command) conflict();
      if (typeof saved.chatId !== 'string' || !saved.chatId.trim())
        throw new HttpError(409, '복사 기록을 확인할 수 없어요.');
      if (!store.db.prepare('SELECT 1 FROM chats WHERE id=?').get(saved.chatId))
        throw new HttpError(410, 'CHAT_COPY_REMOVED');
      return store.chat(saved.chatId);
    }
    // Earlier receipts recorded the original selection in the fork event. Use it
    // when its title also identifies the original command; otherwise validate by
    // the older transcript digest below before recording the new command receipt.
    if (saved) {
      const event = store.db
        .prepare(
          "SELECT entity_id FROM events WHERE chat_id=? AND kind='chat.forked' ORDER BY seq LIMIT 1"
        )
        .get(saved.chatId);
      if (event) {
        const original = JSON.parse(String(event.entity_id)) as {
          chatId: string;
          fromRevision: string | null;
          title: string;
        };
        if (original.chatId !== chatId || original.fromRevision !== sourceId) conflict();
        if (
          (requestedTitle !== null && requestedTitle === original.title) ||
          (requestedTitle === null && saved.automaticCopyTitle === original.title)
        ) {
          rememberCommand();
          return store.chat(saved.chatId);
        }
      }
    }
    const original = store.chat(chatId);
    const title =
      requestedTitle === null
        ? saved
          ? // Earlier receipts hashed the truncated legacy copy title.
            (saved.automaticCopyTitle ?? `${original.title.slice(0, 190)} (사본)`)
          : numberedCopyTitle(store, original.title)
        : requestedTitle;
    const copy = captureChatCopy(store, chatId, sourceId);
    const restored = restoreChatCopy(store, copy, `copy:${requestKey}`, title);
    rememberCommand();
    if (saved) return restored;
    if (requestedTitle === null)
      store.db
        .prepare(
          "UPDATE import_operations SET result=json_set(result,'$.automaticCopyTitle',?) WHERE key=?"
        )
        .run(title, receiptKey);
    if (restored.folderId !== original.folderId)
      store.organization.move(restored.id, {
        expectedRevision: restored.organizationRevision,
        folderId: original.folderId ?? null,
      });
    store.event(
      restored.id,
      'chat.forked',
      JSON.stringify({ chatId, fromRevision: sourceId, title })
    );
    return store.chat(restored.id);
  });
}
