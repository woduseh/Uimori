import type { Connection, ModelRef, ModelPreset } from '../core/product.js';
import type { ProductStore } from './product-store.js';
import { HttpError } from './store.js';

/** Selection controls do not revoke existing role assignments or immutable snapshots. */
export function assertModelSelection(
  store: ProductStore,
  next: ModelRef | null,
  previous: ModelRef | null = null
): void {
  if (!next || previous?.id === next.id) return;
  const latest = store.get<ModelPreset>('model', next.id);
  if (latest.enabled === false) throw new HttpError(400, '비활성 모델은 새로 선택할 수 없어요.');
  const current = store.get<Connection>('connection', latest.connectionId);
  if (!current.enabled) throw new HttpError(400, '비활성 연결의 모델은 새로 선택할 수 없어요.');
}
