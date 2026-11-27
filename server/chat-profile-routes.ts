import type { FastifyInstance } from 'fastify';
import { chatEndpoints } from '#contracts';
import { chatOperations } from '#contracts/operations';
import { registerEndpoint } from './endpoint.js';
import type { Store } from './store.js';

export function chatProfileRoutes(
  app: FastifyInstance,
  store: Store,
  publish: (chatId: string) => void
) {
  registerEndpoint(app, chatEndpoints.readProfile, chatOperations.readProfile, ({ chatId }) =>
    store.product.profile(chatId)
  );
  registerEndpoint(
    app,
    chatEndpoints.updateProfile,
    chatOperations.updateProfile,
    ({ chatId, ...change }) => {
      const profile = store.product.updateProfile(chatId, change);
      publish(profile.chatId);
      return profile;
    }
  );
}
