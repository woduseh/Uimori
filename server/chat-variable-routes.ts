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
import { fields, record, text } from './request-validation.js';
import type { Store } from './store.js';

export function chatVariableRoutes(
  app: FastifyInstance,
  store: Store,
  publish: (chatId: string) => void
) {
  const view = (chatId: string, branchId: string, saved?: ChatVariableState) => {
    const branch = store.product.branch(chatId, branchId);
    const state = saved ?? readChatVariables(store, chatId, branch.id);
    const profile = chatVariableProfile(store, chatId, branch.id);
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
      sourceHash: branch.headRevision ? store.source(branch.headRevision).hash : null,
      pending: chatVariablesPending(store, chatId, branch.id),
      ...(resolved.variableDefaultsError || defaults.variableDefaultsError
        ? {
            variableDefaultsError: resolved.variableDefaultsError ?? defaults.variableDefaultsError,
          }
        : {}),
    };
  };
  app.get<{ Params: { id: string }; Querystring: { branchId?: string } }>(
    '/api/chats/:id/variables',
    (request) => {
      const branch = store.product.branch(request.params.id, request.query.branchId);
      return view(request.params.id, branch.id);
    }
  );
  app.put<{ Params: { id: string }; Querystring: { branchId?: string } }>(
    '/api/chats/:id/variables',
    (request) => {
      const body = record(request.body);
      fields(body, [
        'branchId',
        'expectedRevision',
        'expectedSourceHash',
        'idempotencyKey',
        'values',
      ]);
      const { branchId, ...command } = body;
      const branch = store.product.branch(
        request.params.id,
        branchId === undefined ? request.query.branchId : text(branchId, 'branch ID', 100)
      );
      const state = writeChatVariables(
        store,
        request.params.id,
        branch.id,
        validateChatVariableCommand(command)
      );
      publish(request.params.id);
      return view(request.params.id, branch.id, state);
    }
  );
}
