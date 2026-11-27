import type { FastifyInstance } from 'fastify';
import { chatSettingsEndpoints } from '#contracts';
import { chatSettingsOperations } from '#contracts/operations';
import { chatVariableView } from './chat-variable-context.js';
import { writeChatVariables } from './chat-variables.js';
import { registerEndpoint } from './endpoint.js';
import type { Store } from './store.js';

export function chatVariableRoutes(
  app: FastifyInstance,
  store: Store,
  publish: (chatId: string) => void
) {
  registerEndpoint(
    app,
    chatSettingsEndpoints.readVariables,
    chatSettingsOperations.readVariables,
    ({ chatId }) => chatVariableView(store, chatId)
  );
  registerEndpoint(
    app,
    chatSettingsEndpoints.writeVariables,
    chatSettingsOperations.writeVariables,
    ({ chatId, ...command }) => {
      const state = writeChatVariables(store, chatId, command);
      publish(chatId);
      return chatVariableView(store, chatId, state);
    }
  );
}
