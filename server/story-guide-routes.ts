import type { FastifyInstance } from 'fastify';
import { chatSettingsEndpoints } from '#contracts';
import { chatSettingsOperations } from '#contracts/operations';
import { updateStoryGuideCommand } from './commands/story-guide.js';
import { registerCommand, registerEndpoint } from './endpoint.js';
import { createStorePorts } from './store-ports.js';
import type { Store } from './store.js';

export function storyGuideRoutes(
  app: FastifyInstance,
  store: Store,
  options: { publish: (chatId: string) => void }
) {
  registerEndpoint(
    app,
    chatSettingsEndpoints.readStoryGuide,
    chatSettingsOperations.readStoryGuide,
    ({ chatId }) => store.storyGuide.detail(chatId)
  );
  registerCommand(
    app,
    chatSettingsEndpoints.updateStoryGuide,
    updateStoryGuideCommand,
    createStorePorts(store, { publish: options.publish })
  );
}
