import type { Chat } from '../core/types.js';
import { api, definiteRejection } from './api.js';

/** Persist admission identity before sending; UI locks belong to the calling view. */
export async function requestChatFork(chatId: string, sourceId: string): Promise<Chat> {
  const key = `fork-command:${chatId}:${sourceId}`;
  const storage = sessionStorage;
  const idempotencyKey = storage.getItem(key) || crypto.randomUUID();
  storage.setItem(key, idempotencyKey);

  const clear = () => {
    try {
      if (storage.getItem(key) === idempotencyKey) storage.removeItem(key);
    } catch {
      // Cleanup cannot change an accepted response or mask the original request error.
      // Retaining the key is safe: a later retry resolves the same admission.
    }
  };
  let next: Chat;
  try {
    next = await api<Chat>(`/chats/${chatId}/fork`, {
      fromRevision: sourceId,
      idempotencyKey,
    });
  } catch (error) {
    if (definiteRejection(error)) clear();
    throw error;
  }
  clear();
  return next;
}
