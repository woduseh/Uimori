import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';

/** A user's own composition edit is its own authority; the model path goes through the helper. */
export function outlineRoutes(
  app: FastifyInstance,
  store: Store,
  hooks: { publish: (chatId: string) => void }
) {
  app.get<{ Params: { id: string }; Querystring: { branchId?: string } }>(
    '/api/chats/:id/outline',
    async (request) => store.outline.detail(request.params.id, request.query.branchId)
  );
  app.post<{ Params: { id: string } }>('/api/chats/:id/outline', async (request) => {
    const result = store.outline.apply(request.params.id, request.body, 'user');
    hooks.publish(request.params.id);
    return result;
  });
  app.post<{ Params: { id: string } }>('/api/outline-nodes/:id/scene-command', async (request) => {
    const command = store.outline.sceneCommand(request.params.id, request.body);
    hooks.publish(command.chatId);
    return command;
  });
}
