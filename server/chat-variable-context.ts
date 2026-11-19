import type { ChatVariableState } from '../core/chat-variables.js';
import type { ProfileSnapshot } from '../core/product.js';
import { resolveTemplateVariableContext } from '../core/template-variables.js';
import { chatVariablesPending, readChatVariables } from './chat-variables.js';
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

/** Chat overrides with the authored defaults they replace and the values a request would resolve. */
export function chatVariableView(store: Store, chatId: string, saved?: ChatVariableState) {
  const chat = store.chat(chatId);
  const state = saved ?? readChatVariables(store, chatId);
  const profile = chatVariableProfile(store, chatId);
  const defaults = resolveTemplateVariableContext(
    profile ? { ...profile, variableState: undefined } : undefined
  );
  const resolved = resolveTemplateVariableContext(
    profile ? { ...profile, ...(state.revision > 0 ? { variableState: state } : {}) } : undefined
  );
  return {
    ...state,
    defaults: defaults.variables ?? {},
    resolved: resolved.variables ?? {},
    sourceHash: chat.headRevision ? store.source(chat.headRevision).hash : null,
    pending: chatVariablesPending(store, chatId),
    ...(resolved.variableDefaultsError || defaults.variableDefaultsError
      ? {
          variableDefaultsError: resolved.variableDefaultsError ?? defaults.variableDefaultsError,
        }
      : {}),
  };
}
