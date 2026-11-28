import type { FastifyInstance } from 'fastify';
import { chatSettingsEndpoints } from '#contracts';
import { chatSettingsOperations } from '#contracts/operations';
import { chatVariableView } from './chat-variable-context.js';
import { updateChatVariablesCommand } from './commands/chat-variables.js';
import { registerCommand, registerEndpoint } from './endpoint.js';
import { createStorePorts } from './store-ports.js';
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
  registerCommand(
    app,
    chatSettingsEndpoints.writeVariables,
    updateChatVariablesCommand,
    createStorePorts(store, { publish })
  );
}
