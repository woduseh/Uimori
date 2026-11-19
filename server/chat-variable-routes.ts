import type { FastifyInstance } from 'fastify';
import { chatVariableView } from './chat-variable-context.js';
import { writeChatVariables, validateChatVariableCommand } from './chat-variables.js';
import { fields, record } from './request-validation.js';
import type { Store } from './store.js';

export function chatVariableRoutes(
  app: FastifyInstance,
  store: Store,
  publish: (chatId: string) => void
) {
  app.get<{ Params: { id: string } }>('/api/chats/:id/variables', (request) =>
    chatVariableView(store, request.params.id)
  );
  app.put<{ Params: { id: string } }>('/api/chats/:id/variables', (request) => {
    const body = record(request.body);
    fields(body, ['expectedRevision', 'expectedSourceHash', 'idempotencyKey', 'values']);
    const state = writeChatVariables(store, request.params.id, validateChatVariableCommand(body));
    publish(request.params.id);
    return chatVariableView(store, request.params.id, state);
  });
}
