import { captureChatCopy, restoreChatCopy } from './chat-copy.js';
import { fields, record, text } from './request-validation.js';
import type { Chat, Store } from './store.js';

function numberedCopyTitle(store: Store, title: string): string {
  const base = title.replace(/(?: · (?:새 이야기|사본 [1-9]\d*)| \(사본\))+$/u, '') || title;
  let last = 0;
  for (const row of store.db.prepare('SELECT title FROM chats').all()) {
    const existing = String(row.title);
    const match = existing.match(/ · 사본 ([1-9]\d*)$/u);
    if (!match || existing.slice(0, match.index) !== base.slice(0, 200 - match[0].length)) continue;
    const number = Number(match[1]);
    if (Number.isSafeInteger(number)) last = Math.max(last, number);
  }
  const suffix = ` · 사본 ${last + 1}`;
  return base.slice(0, 200 - suffix.length) + suffix;
}

/** A fork is a new chat with copied user data, not a shared execution/snapshot graph. */
export function forkChat(store: Store, chatId: string, value: unknown): Chat {
  const body = record(value);
  fields(body, ['fromRevision', 'title', 'idempotencyKey']);
  const sourceId = body.fromRevision === null ? null : text(body.fromRevision, 'source ID', 100);
  const requestKey = text(body.idempotencyKey, 'copy request', 100);
  return store.transaction(() => {
    const original = store.chat(chatId);
    const receiptKey = `transcript:copy:${requestKey}`;
    // Freeze the allocated name on its existing receipt so a lost response does
    // not choose a new number. Older receipts retain their original naming rule.
    const saved = store.db
      .prepare(
        "SELECT json_extract(result,'$.automaticCopyTitle') AS title FROM import_operations WHERE key=?"
      )
      .get(receiptKey);
    const title =
      body.title === undefined
        ? saved
          ? ((saved.title as string | null) ?? `${original.title.slice(0, 190)} (사본)`)
          : numberedCopyTitle(store, original.title)
        : text(body.title, 'title', 200);
    const copy = captureChatCopy(store, chatId, sourceId);
    const restored = restoreChatCopy(store, copy, `copy:${requestKey}`, title);
    if (body.title === undefined)
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
