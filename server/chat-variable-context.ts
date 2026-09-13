import type { ProfileSnapshot } from '../core/product.js';
import { readChatVariables } from './chat-variables.js';
import type { Store } from './store.js';

/** Live projection with an explicit branch; persisted Run profiles never call this on resume. */
export function chatVariableProfile(
  store: Store,
  chatId: string,
  branchId: string,
  profile = store.product.snapshot(
    chatId,
    'main',
    store.product.branch(chatId, branchId).headRevision
  )
): ProfileSnapshot {
  const state = readChatVariables(store, chatId, branchId);
  const result = { ...profile };
  if (state.revision > 0) result.variableState = state;
  else delete result.variableState;
  return result;
}
