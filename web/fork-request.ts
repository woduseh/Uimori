import type { Chat } from '../core/types.js';
import { api, ApiError, definiteRejection } from './api.js';

export async function requestChatFork(chatId: string, sourceId: string | null): Promise<Chat> {
  const key = `fork-command:${chatId}:${sourceId}`;
  const storage = sessionStorage;
  const previous = storage.getItem(key);
  const idempotencyKey = previous || crypto.randomUUID();
  storage.setItem(key, idempotencyKey);

  const clear = () => {
    try {
      if (storage.getItem(key) === idempotencyKey) storage.removeItem(key);
    } catch {}
  };
  let next: Chat;
  try {
    next = await api<Chat>(`/chats/${chatId}/fork`, {
      fromRevision: sourceId,
      idempotencyKey,
    });
  } catch (error) {
    if (
      (error instanceof ApiError && error.status === 410 && error.code === 'CHAT_COPY_REMOVED') ||
      (error instanceof ApiError &&
        error.status === 409 &&
        error.code === 'CHAT_COPY_RECEIPT_UNVERIFIED') ||
      (!previous && definiteRejection(error))
    )
      clear();
    throw error;
  }
  clear();
  return next;
}
