import { HttpError, fields, record } from './request-validation.js';
import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';

/** Hide from future catalogs while retaining historical image bytes and references. */
export function deleteChatAsset(store: Store, chatId: string, assetId: string, value: unknown) {
  fields(record(value), []);
  return store.transaction(() => {
    store.chat(chatId);
    const row = store.db.prepare('SELECT chat_id FROM assets WHERE id=?').get(assetId);
    if (!row || row.chat_id !== chatId)
      throw new HttpError(404, '이 이야기의 이미지를 찾지 못했어요.');
    store.product.assertAvailable('asset', assetId);
    store.db.prepare("INSERT INTO library_hidden(kind,id) VALUES('asset',?)").run(assetId);
    store.event(chatId, 'asset.deleted', assetId);
    return { deleted: true, id: assetId };
  });
}

export function assetDeletionRoutes(
  app: FastifyInstance,
  store: Store,
  publish: (chatId: string) => void
) {
  app.delete<{ Params: { chatId: string; id: string } }>(
    '/api/chats/:chatId/assets/:id',
    async (request) => {
      const result = deleteChatAsset(store, request.params.chatId, request.params.id, request.body);
      publish(request.params.chatId);
      return result;
    }
  );
}
