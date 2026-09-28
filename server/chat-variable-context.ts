import type { ProfileSnapshot } from '../core/product.js';
import { readChatVariables } from './chat-variables.js';
import type { Store } from './store.js';

/** Live projection; persisted Run profiles never call this on resume. */
export function chatVariableProfile(
  store: Store,
  chatId: string,
  profile = store.product.snapshot(chatId, 'main', store.chat(chatId).headRevision)
): ProfileSnapshot {
  const state = readChatVariables(store, chatId);
  const result = { ...profile };
  if (state.revision > 0) result.variableState = state;
  else delete result.variableState;
  return result;
}
