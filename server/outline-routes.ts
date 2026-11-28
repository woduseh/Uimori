import type { FastifyInstance } from 'fastify';
import { outlineEndpoints } from '#contracts';
import { applyOutlineCommand, setOutlineFocusCommand } from './commands/outline.js';
import { registerCommand } from './endpoint.js';
import { createStorePorts } from './store-ports.js';
import type { Store } from './store.js';

export function outlineRoutes(
  app: FastifyInstance,
  store: Store,
  hooks: { publish: (chatId: string) => void }
) {
  const ports = createStorePorts(store, { publish: hooks.publish });
  app.get<{ Params: { id: string } }>('/api/chats/:id/outline', async (request) =>
    store.outline.detail(request.params.id)
  );
  app.get<{ Params: { id: string } }>('/api/chats/:id/outline/focus', async (request) =>
    store.outline.focus(request.params.id)
  );
  registerCommand(app, outlineEndpoints.setFocus, setOutlineFocusCommand, ports);
  app.get<{ Params: { id: string } }>('/api/outline-nodes/:id/brief', (request) =>
    store.outline.preview(request.params.id)
  );
  registerCommand(app, outlineEndpoints.apply, applyOutlineCommand, ports);
  app.post<{ Params: { id: string } }>(
    '/api/outline-nodes/:id/scene-command',
    { bodyLimit: 16 * 1024 * 1024 },
    async (request) => {
      const command = store.outline.sceneCommand(request.params.id, request.body);
      hooks.publish(command.chatId);
      return command;
    }
  );
}
