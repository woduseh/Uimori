import { randomUUID } from 'node:crypto';
import type { Store } from '../../server/store.js';

export function writeNote(
  store: Store,
  chatId: string,
  body: { text: string; author: string; branchId?: string; retired?: true },
  replacesId?: string
) {
  const branch = store.product.branch(chatId, body.branchId);
  return store.story.notes.write(chatId, {
    ...body,
    branchId: branch.id,
    expectedHeadRevision: branch.headRevision,
    expectedRevision: store.story.notes.revision(chatId),
    idempotencyKey: randomUUID(),
    ...(replacesId ? { replacesId } : {}),
  }).note;
}
