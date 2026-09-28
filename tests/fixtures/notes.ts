import { randomUUID } from 'node:crypto';
import type { Store } from '../../server/store.js';

export function writeNote(
  store: Store,
  chatId: string,
  body: { text: string; author: string; retired?: true },
  replacesId?: string
) {
  const chat = store.chat(chatId);
  return store.story.notes.write(chatId, {
    ...body,
    expectedHeadRevision: chat.headRevision,
    expectedRevision: store.story.notes.revision(chatId),
    idempotencyKey: randomUUID(),
    ...(replacesId ? { replacesId } : {}),
  }).note;
}
