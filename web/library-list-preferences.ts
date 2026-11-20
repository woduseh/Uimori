import type { LibraryCategory } from '../core/library-organization.js';

export type LibrarySort = 'name' | 'name-desc' | 'manual';

function saveCategoryPreference(
  key: string,
  category: LibraryCategory,
  value: LibrarySort | string[]
) {
  try {
    const current = JSON.parse(localStorage.getItem(key) ?? '{}');
    localStorage.setItem(key, JSON.stringify({ ...current, [category]: value }));
  } catch {}
}

export function saveLibrarySort(category: LibraryCategory, sort: LibrarySort) {
  saveCategoryPreference('uimori-library-sorts', category, sort);
}

export function saveLibraryManualOrder(category: LibraryCategory, ids: string[]) {
  saveCategoryPreference('uimori-library-manual-orders', category, ids);
}
