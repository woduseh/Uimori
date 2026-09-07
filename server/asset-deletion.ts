import type { FastifyInstance } from 'fastify';
import { fields, record } from './product-store.js';
import { HttpError, type Store } from './store.js';

/** Catalog entries are immutable archive dependencies, even when no image was displayed. */
export function deleteChatAsset(store: Store, chatId: string, assetId: string, value: unknown) {
  fields(record(value), []);
  return store.transaction(() => {
    store.chat(chatId);
    const row = store.db.prepare('SELECT chat_id FROM assets WHERE id=?').get(assetId);
    if (!row || row.chat_id !== chatId) throw new HttpError(404, '이 이야기의 이미지를 찾지 못했어요.');
    if (store.db.prepare("SELECT 1 FROM runs WHERE chat_id=? AND status IN ('queued','running','waiting_for_state') LIMIT 1").get(chatId)
      || store.db.prepare("SELECT 1 FROM jobs WHERE chat_id=? AND status IN ('queued','running') LIMIT 1").get(chatId)) {
      throw new HttpError(409, '진행 중인 생성이나 보조 작업이 있어요. 완료하거나 취소한 뒤 이미지를 삭제해 주세요.');
    }
    // Check actual JSON values rather than substring matches in authored text.
    const referenced = [
      ['profiles', 'body'], ['runs', 'snapshot'], ['jobs', 'input'], ['job_results', 'result'],
    ].some(([table, column]) => store.db.prepare(`SELECT 1 FROM ${table}, json_tree(${table}.${column}) ref WHERE ref.type='text' AND ref.atom IN (?,?) LIMIT 1`).get(assetId, `/api/assets/${assetId}`));
    if (referenced) throw new HttpError(409, '이 이미지가 이야기 설정이나 과거 실행·이미지 작업에 저장되어 있어요. 해당 이야기를 삭제하면 이미지도 함께 삭제돼요.');
    store.db.prepare('DELETE FROM assets WHERE id=? AND chat_id=?').run(assetId, chatId);
    store.event(chatId, 'asset.deleted', assetId);
    return { deleted: true, id: assetId };
  });
}

export function assetDeletionRoutes(app: FastifyInstance, store: Store, publish: (chatId: string) => void) {
  app.delete<{Params:{chatId:string;id:string}}>('/api/chats/:chatId/assets/:id', async request => {
    const result = deleteChatAsset(store, request.params.chatId, request.params.id, request.body);
    publish(request.params.chatId);
    return result;
  });
}
