import { captureChatCopy, restoreChatCopy } from './chat-copy.js';
import { createHash } from 'node:crypto';
import { chatTitle, fields, HttpError, record, text } from './request-validation.js';
import type { Chat, Store } from './store.js';

function numberedCopyTitle(store: Store, title: string): string {
  const base =
    title.replace(/(?: \(사본(?: [1-9]\d*)?\))+/gu, (run, offset) =>
      offset + run.length === title.length ? '' : run
    ) || title;
  let last = 0;
  for (const row of store.db.prepare('SELECT title FROM chats').all()) {
    const existing = String(row.title);
    const match = existing.match(/ \(사본 ([1-9]\d*)\)$/u);
    if (!match || existing.slice(0, match.index) !== base) continue;
    const number = Number(match[1]);
    if (Number.isSafeInteger(number)) last = Math.max(last, number);
  }
  return `${base} (사본 ${last + 1})`;
}

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
      ? (JSON.parse(String(row.result)) as { chatId: string; forkCommand?: string })
      : undefined;
    if (saved) {
      if (!saved.forkCommand || typeof saved.chatId !== 'string' || !saved.chatId.trim())
        throw new HttpError(409, 'CHAT_COPY_RECEIPT_UNVERIFIED');
      if (saved.forkCommand !== command)
        throw new HttpError(409, '다른 채팅에 같은 가져오기 ID가 사용됐어요.');
      if (!store.db.prepare('SELECT 1 FROM chats WHERE id=?').get(saved.chatId))
        throw new HttpError(410, 'CHAT_COPY_REMOVED');
      return store.chat(saved.chatId);
    }
    const original = store.chat(chatId);
    const title = requestedTitle ?? numberedCopyTitle(store, original.title);
    const copy = captureChatCopy(store, chatId, sourceId);
    const restored = restoreChatCopy(store, copy, `copy:${requestKey}`, title);
    store.db
      .prepare("UPDATE import_operations SET result=json_set(result,'$.forkCommand',?) WHERE key=?")
      .run(command, receiptKey);
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
