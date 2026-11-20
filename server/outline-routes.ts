import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';

export function outlineRoutes(
  app: FastifyInstance,
  store: Store,
  hooks: { publish: (chatId: string) => void }
) {
  app.get<{ Params: { id: string } }>('/api/chats/:id/outline', async (request) =>
    store.outline.detail(request.params.id)
  );
  app.get<{ Params: { id: string } }>('/api/chats/:id/outline/focus', async (request) =>
    store.outline.focus(request.params.id)
  );
  app.put<{ Params: { id: string } }>('/api/chats/:id/outline/focus', async (request) => {
    const focus = store.outline.setFocus(request.params.id, request.body);
    hooks.publish(request.params.id);
    return focus;
  });
  app.get<{ Params: { id: string } }>('/api/outline-nodes/:id/brief', (request) =>
    store.outline.preview(request.params.id)
  );
  app.post<{ Params: { id: string } }>(
    '/api/chats/:id/outline',
    { bodyLimit: 16 * 1024 * 1024 },
    async (request) => {
      const result = store.outline.apply(request.params.id, request.body, 'user');
      hooks.publish(request.params.id);
      return result;
    }
  );
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
