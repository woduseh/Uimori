import type { Store } from './store.js';
import type { Asset } from '../core/product.js';
import { fields, HttpError, number, record, text } from './request-validation.js';

/** Names used by the reader and JEV are independent of immutable image bytes. */
export function updateAssetMetadata(
  store: Store,
  chatId: string,
  id: string,
  value: unknown
): Asset {
  const input = record(value);
  fields(input, ['expectedRevision', 'title', 'description']);
  return store.transaction(() => {
    const row = store.db
      .prepare('SELECT body FROM assets WHERE id=? AND chat_id=?')
      .get(id, chatId);
    if (!row) throw new HttpError(404, 'Image not found');
    const current: Asset = JSON.parse(String(row.body));
    if (current.revision !== number(input.expectedRevision, 'image revision', 1))
      throw new HttpError(409, '이미지 정보가 변경됐어요. 다시 열어 주세요.');
    const saved = {
      ...current,
      revision: current.revision + 1,
      title: text(input.title, 'image name', 200),
      description: text(input.description, 'image description', 2000, true),
    };
    store.db.prepare('UPDATE assets SET body=? WHERE id=?').run(JSON.stringify(saved), id);
    store.event(chatId, 'asset.updated', id);
    return saved;
  });
}
