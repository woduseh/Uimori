import type { Connection, ContentRef, ModelPreset } from '../core/product.js';
import type { ProductStore } from './product-store.js';
import { HttpError } from './store.js';

/** Selection controls do not revoke existing role assignments or immutable snapshots. */
export function assertModelSelection(store: ProductStore, next: ContentRef | null, previous: ContentRef | null = null): void {
  if (!next || previous?.id === next.id && previous.revision === next.revision) return;
  const latest = store.get<ModelPreset>('model',next.id);
  if (latest.enabled === false) throw new HttpError(400,'비활성 모델은 새로 선택할 수 없어요.');
  const selected = store.get<ModelPreset>('model',next.id,next.revision);
  const pinned = store.get<Connection>('connection',selected.connectionId,selected.connectionRevision);
  const current = store.get<Connection>('connection',selected.connectionId);
  if (!pinned.enabled || !current.enabled || ['protocol','endpoint','credentialEnv','requestTier'].some(key => pinned[key as keyof Connection] !== current[key as keyof Connection])) throw new HttpError(400,'연결이 비활성이거나 권한이 변경됐어요. 연결을 확인한 모델을 새로 선택해 주세요.');
}
