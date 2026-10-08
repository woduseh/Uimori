import type { LibraryCategory } from '../core/library-organization.js';

export type LibrarySort = 'name' | 'name-desc' | 'manual';

function saveCategoryPreference(
  key: string,
  category: LibraryCategory,
  value: LibrarySort | string[]
) {
  try {
    const current = JSON.parse(localStorage.getItem(key) ?? '{}');
    // These keys are shared by the library and prompts; update only the current category.
    localStorage.setItem(key, JSON.stringify({ ...current, [category]: value }));
  } catch {
    /* Keep this session's choice in a restricted browser. */
  }
}

export function saveLibrarySort(category: LibraryCategory, sort: LibrarySort) {
  saveCategoryPreference('uimori-library-sorts', category, sort);
}

export function saveLibraryManualOrder(category: LibraryCategory, ids: string[]) {
  saveCategoryPreference('uimori-library-manual-orders', category, ids);
}
