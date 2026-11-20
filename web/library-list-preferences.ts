import type { LibraryCategory } from '../core/library-organization.js';
import { readOptionalJson, writeOptionalStorage } from './optional-storage.js';

export type LibrarySort = 'name' | 'name-desc' | 'manual';

function saveCategoryPreference(
  key: string,
  category: LibraryCategory,
  value: LibrarySort | string[]
) {
  const stored = readOptionalJson('local', key, null);
  const current = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  writeOptionalStorage('local', key, JSON.stringify({ ...current, [category]: value }));
}

export function saveLibrarySort(category: LibraryCategory, sort: LibrarySort) {
  saveCategoryPreference('uimori-library-sorts', category, sort);
}

export function saveLibraryManualOrder(category: LibraryCategory, ids: string[]) {
  saveCategoryPreference('uimori-library-manual-orders', category, ids);
}
