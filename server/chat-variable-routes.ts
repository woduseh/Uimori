import type { FastifyInstance } from 'fastify';
import { resolveTemplateVariableContext } from '../core/template-variables.js';
import type { ChatVariableState } from '../core/chat-variables.js';
import { chatVariableProfile } from './chat-variable-context.js';
import {
  readChatVariables,
  writeChatVariables,
  validateChatVariableCommand,
  chatVariablesPending,
} from './chat-variables.js';
import { fields, record } from './request-validation.js';
import type { Store } from './store.js';

export function chatVariableRoutes(
  app: FastifyInstance,
  store: Store,
  publish: (chatId: string) => void
) {
  const view = (chatId: string, saved?: ChatVariableState) => {
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
  };
  app.get<{ Params: { id: string } }>('/api/chats/:id/variables', (request) =>
    view(request.params.id)
  );
  app.put<{ Params: { id: string } }>('/api/chats/:id/variables', (request) => {
    const body = record(request.body);
    fields(body, ['expectedRevision', 'expectedSourceHash', 'idempotencyKey', 'values']);
    const state = writeChatVariables(store, request.params.id, validateChatVariableCommand(body));
    publish(request.params.id);
    return view(request.params.id, state);
  });
}
