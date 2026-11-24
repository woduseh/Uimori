import {
  libraryItemKey,
  type LibraryFolder,
  type LibraryItemKey,
  type LibraryOrganization,
  type LibraryPlacement,
} from '../core/library-organization.js';
import type { LibrarySort } from './library-list-preferences.js';

type Listed = { id: string; title: string };
export type LibrarySection<T> = { folder: LibraryFolder | null; items: T[] };

export function libraryPlacements(organization: LibraryOrganization | null | undefined) {
  return new Map<string, LibraryPlacement>(
    organization?.items.map((placement) => [libraryItemKey(placement), placement]) ?? []
  );
}

export function placementOf(placements: Map<string, LibraryPlacement>, item: LibraryItemKey) {
  return placements.get(libraryItemKey(item));
}

export function sortLibraryItems<T extends Listed>(
  items: T[],
  sort: LibrarySort,
  manualOrder: string[],
  locale: string
) {
  const position = new Map(manualOrder.map((id, index) => [id, index]));
  const last = Number.MAX_SAFE_INTEGER;
  return [...items].sort((a, b) =>
    sort === 'manual'
      ? (position.get(a.id) ?? last) - (position.get(b.id) ?? last) ||
        a.title.localeCompare(b.title, locale)
      : (sort === 'name-desc' ? -1 : 1) * a.title.localeCompare(b.title, locale)
  );
}

export function reorderManually<T extends Listed>(
  items: T[],
  manualOrder: string[],
  locale: string,
  id: string,
  beforeId: string | null
) {
  const available = new Set(items.map((item) => item.id));
  const ordered = [
    ...manualOrder.filter((itemId) => available.has(itemId)),
    ...sortLibraryItems(
      items.filter((item) => !manualOrder.includes(item.id)),
      'name',
      [],
      locale
    ).map((item) => item.id),
  ].filter((itemId) => itemId !== id);
  const index = beforeId === null ? -1 : ordered.indexOf(beforeId);
  ordered.splice(index < 0 ? ordered.length : index, 0, id);
  return ordered;
}

export function neighbourTarget<T extends Listed>(list: T[], id: string, offset: -1 | 1) {
  const index = list.findIndex((item) => item.id === id);
  if (index < 0 || !list[index + offset]) return undefined;
  return offset < 0 ? list[index - 1].id : (list[index + 2]?.id ?? null);
}

export function librarySections<T>(
  items: T[],
  folders: LibraryFolder[],
  folderOf: (item: T) => string | null
): LibrarySection<T>[] {
  const known = new Set(folders.map((folder) => folder.id));
  const grouped = new Map<string | null, T[]>();
  for (const item of items) {
    const folderId = folderOf(item);
    const key = folderId !== null && known.has(folderId) ? folderId : null;
    const list = grouped.get(key);
    if (list) list.push(item);
    else grouped.set(key, [item]);
  }
  const loose = grouped.get(null) ?? [];
  return [
    ...folders.map((folder) => ({ folder, items: grouped.get(folder.id) ?? [] })),
    ...(loose.length ? [{ folder: null, items: loose }] : []),
  ];
}
