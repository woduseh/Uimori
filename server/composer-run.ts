import type { RequestImage } from '../core/request-images.js';
import type { Chat, RunSnapshot } from '../core/types.js';
import type { Store } from './store.js';

/** The snapshot a new main request reserves from the chat's current story and settings. */
export function composerRunSnapshot(
  store: Store,
  chat: Chat,
  request: string,
  requestImages: readonly RequestImage[] = []
): RunSnapshot {
  const profile = store.product.snapshot(chat.id);
  return {
    chatId: chat.id,
    parentRevision: chat.headRevision,
    settingsRevision: chat.settingsRevision,
    settings: chat.settings,
    request,
    ...(requestImages.length ? { requestImages: [...requestImages] } : {}),
    history: store.history(chat.headRevision),
    resources: store.product.resources(chat.id, profile),
    ...(profile ? { profile } : {}),
  };
}
