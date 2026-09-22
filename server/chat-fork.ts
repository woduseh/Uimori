import { captureChatCopy, restoreChatCopy } from './chat-copy.js';
import { fields, record, text } from './request-validation.js';
import type { Chat, Store } from './store.js';

/** A fork is a new chat with copied user data, not a shared execution/snapshot graph. */
export function forkChat(store: Store, chatId: string, value: unknown): Chat {
  const body = record(value);
  fields(body, ['fromRevision', 'branchId', 'title', 'idempotencyKey']);
  const sourceId = body.fromRevision === null ? null : text(body.fromRevision, 'source ID', 100);
  const branchId = body.branchId === undefined ? undefined : text(body.branchId, 'branch ID', 100);
  const requestKey = text(body.idempotencyKey, 'copy request', 100);
  return store.transaction(() => {
    const original = store.chat(chatId);
    const title =
      body.title === undefined
        ? `${original.title.slice(0, 190)} (사본)`
        : text(body.title, 'title', 200);
    const copy = captureChatCopy(store, chatId, branchId, sourceId);
    const restored = restoreChatCopy(store, copy, `copy:${requestKey}`, title);
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
