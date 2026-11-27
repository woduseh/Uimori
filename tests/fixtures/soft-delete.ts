import { deleteLibraryItem, type LibraryKind } from '../../server/library-deletion.js';
import type { Store } from '../../server/store.js';

export function softDeleteLibraryItem<T extends { id: string; revision: number }>(
  store: Store,
  kind: LibraryKind,
  item: T
): T {
  store.product.content({
    kind: 'module',
    title: 'Soft-delete reference',
    description: item.id,
    text: 'Keeps the deleted item referenced, as saved text that names it does.',
    loading: 'pinned',
    relatedIds: [],
  });
  deleteLibraryItem(store, kind, item.id, { expectedRevision: item.revision });
  if (!store.product.isHidden(kind, item.id)) throw new Error(`${kind} was purged`);
  return store.product.stored<T>(kind, item.id);
}
