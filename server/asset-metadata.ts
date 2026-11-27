import type { UpdateChatAsset } from '#contracts';
import type { Store } from './store.js';
import type { Asset } from '../core/product.js';
import { AppError } from './app-errors.js';

export function updateAssetMetadata(
  store: Store,
  { chatId, assetId, expectedRevision, title, description }: UpdateChatAsset
): Asset {
  return store.transaction(() => {
    const current = store.product.writableAsset(chatId, assetId);
    if (current.revision !== expectedRevision) throw new AppError(409, 'REVISION_CONFLICT');
    const saved = { ...current, revision: current.revision + 1, title, description };
    store.db.prepare('UPDATE assets SET body=? WHERE id=?').run(JSON.stringify(saved), assetId);
    store.event(chatId, 'asset.updated', assetId);
    return saved;
  });
}
