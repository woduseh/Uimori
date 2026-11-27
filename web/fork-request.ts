import type { Chat } from '../core/types.js';
import { chatEndpoints } from '#contracts';
import { ApiError, callEndpoint, definiteRejection } from './api.js';
import { getLocale } from './i18n.js';
import { storageKeys } from './storage-keys.js';

export async function requestChatFork(chatId: string, sourceId: string | null): Promise<Chat> {
  const key = storageKeys.forkCommand(chatId, sourceId);
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
    next = (await callEndpoint(chatEndpoints.forkChat, {
      chatId,
      fromRevision: sourceId,
      titleLocale: getLocale(),
      idempotencyKey,
    })) as Chat;
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
