import type { FastifyInstance } from 'fastify';
import { z } from 'zod/v4';
import { chatEndpoints } from '#contracts';
import { chatOperations, nonBlank } from '#contracts/operations';
import { deleteChatAsset } from './asset-deletion.js';
import { updateAssetMetadata } from './asset-metadata.js';
import { registerEndpoint, registerRawRoute } from './endpoint.js';
import { processImageUpload } from './image-processing.js';
import type { Store } from './store.js';

const assetBytesInput = z.strictObject({ id: nonBlank(100) });

export function chatAssetRoutes(
  app: FastifyInstance,
  store: Store,
  publish: (chatId: string) => void
) {
  registerEndpoint(
    app,
    chatEndpoints.uploadAsset,
    chatOperations.uploadAsset,
    async ({ chatId, base64, ...details }) => {
      store.writableChat(chatId);
      const image = await processImageUpload({ base64 });
      const asset = store.product.createAsset(chatId, { ...details, ...image });
      store.event(asset.chatId, 'asset.created', asset.id);
      publish(asset.chatId);
      return asset;
    }
  );
  registerEndpoint(app, chatEndpoints.updateAsset, chatOperations.updateAsset, (input) => {
    const asset = updateAssetMetadata(store, input);
    publish(input.chatId);
    return asset;
  });
  registerEndpoint(app, chatEndpoints.deleteAsset, chatOperations.deleteAsset, (input) => {
    const result = deleteChatAsset(store, input);
    publish(input.chatId);
    return result;
  });
  registerRawRoute(
    app,
    {
      method: 'GET',
      url: '/api/assets/:id',
      cache: 'no-store-refusals',
      input: assetBytesInput,
    },
    ({ id }, _request, reply) => {
      const { asset, bytes } = store.product.asset(id);
      return reply
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, max-age=86400')
        .type(asset.mime)
        .send(bytes);
    }
  );
}
