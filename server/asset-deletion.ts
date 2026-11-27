import { pruneUnusedData } from './unused-data.js';
import type { ChatAssetTarget } from '#contracts';
import type { Store } from './store.js';

export function deleteChatAsset(store: Store, { chatId, assetId }: ChatAssetTarget) {
  return store.transaction(() => {
    store.product.writableAsset(chatId, assetId);
    store.db.prepare("INSERT INTO library_hidden(kind,id) VALUES('asset',?)").run(assetId);
    store.event(chatId, 'asset.deleted', assetId);
    pruneUnusedData(store.db);
    return { deleted: true as const, id: assetId };
  });
}
