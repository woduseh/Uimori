import { patchHelperResource } from './helper-resource-editing.js';
import { HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

type PatchItem = {
  kind: 'content' | 'prompt-preset';
  id: string;
  expectedRevision: number;
  changes: unknown[];
};

/** Adds the failing resource without discarding the single-patch diagnostic. */
export class HelperResourceBatchError extends HttpError {
  constructor(
    readonly itemIndex: number,
    readonly kind: PatchItem['kind'] | undefined,
    readonly id: string | undefined,
    override readonly cause: HttpError
  ) {
    super(cause.statusCode, cause.message);
  }
}

/** Validate all identities before reading mutation snapshots or writing any batch member. */
export function helperResourceBatchItems(rawItems: unknown): PatchItem[] {
  if (!Array.isArray(rawItems) || !rawItems.length || rawItems.length > 16)
    throw new HttpError(400, '수정할 자료는 1개부터 16개까지 지정해 주세요.');
  const seen = new Set<string>();
  return rawItems.map((raw, itemIndex): PatchItem => {
    let kind: PatchItem['kind'] | undefined;
    let id: string | undefined;
    try {
      const item = record(raw);
      if (item.kind !== 'content' && item.kind !== 'prompt-preset')
        throw new HttpError(400, '부분 수정은 native 자료와 프리셋에만 지원해요.');
      kind = item.kind === 'content' ? 'content' : 'prompt-preset';
      id = text(item.id, 'id', 200);
      const expectedRevision = number(item.expectedRevision, 'revision');
      if (!Array.isArray(item.changes) || !item.changes.length)
        throw new HttpError(400, '변경 목록이 필요해요.');
      const key = JSON.stringify([kind, id]);
      if (seen.has(key)) throw new HttpError(400, '같은 자료는 한 번만 지정해 주세요.');
      seen.add(key);
      return { kind, id, expectedRevision, changes: item.changes };
    } catch (error) {
      if (error instanceof HttpError)
        throw new HelperResourceBatchError(itemIndex, kind, id, error);
      throw error;
    }
  });
}

export function patchHelperResources(store: Store, rawItems: unknown) {
  const items = helperResourceBatchItems(rawItems);
  return store.transaction(() => ({
    items: items.map((item, itemIndex) => {
      try {
        return {
          kind: item.kind,
          ...patchHelperResource(store, item.kind, item.id, item.expectedRevision, item.changes),
        };
      } catch (error) {
        if (error instanceof HttpError)
          throw new HelperResourceBatchError(itemIndex, item.kind, item.id, error);
        throw error;
      }
    }),
  }));
}
