import { patchHelperResource } from './helper-resource-editing.js';
import { HelperToolError } from './app-errors.js';
import { HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

type PatchItem = {
  kind: 'content' | 'prompt-preset' | 'theme';
  id: string;
  expectedRevision: number;
  changes: unknown[];
};

export class HelperResourceBatchError extends HttpError {
  readonly itemIndex: number;
  readonly kind: PatchItem['kind'] | undefined;
  readonly id: string | undefined;
  override readonly cause: HttpError;
  constructor(
    itemIndex: number,
    kind: PatchItem['kind'] | undefined,
    id: string | undefined,
    cause: HttpError
  ) {
    super(cause.statusCode, cause.message);
    this.itemIndex = itemIndex;
    this.kind = kind;
    this.id = id;
    this.cause = cause;
  }
}

export function helperResourceBatchItems(rawItems: unknown): PatchItem[] {
  if (!Array.isArray(rawItems) || !rawItems.length || rawItems.length > 16)
    throw new HelperToolError(400, 'INVALID_ARGUMENTS', 'items must list 1 to 16 resources');
  const seen = new Set<string>();
  return rawItems.map((raw, itemIndex): PatchItem => {
    let kind: PatchItem['kind'] | undefined;
    let id: string | undefined;
    try {
      const item = record(raw);
      const inputKind: unknown = item.kind;
      if (inputKind !== 'content' && inputKind !== 'prompt-preset' && inputKind !== 'theme')
        throw new HelperToolError(
          400,
          'INVALID_ARGUMENTS',
          'kind must be content, prompt-preset or theme'
        );
      kind = inputKind;
      id = text(item.id, 'id', 200);
      const expectedRevision = number(item.expectedRevision, 'revision');
      if (!Array.isArray(item.changes) || !item.changes.length)
        throw new HelperToolError(400, 'INVALID_ARGUMENTS', 'changes must be a non-empty list');
      const key = JSON.stringify([kind, id]);
      if (seen.has(key))
        throw new HelperToolError(400, 'INVALID_ARGUMENTS', 'Each resource may appear only once');
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
