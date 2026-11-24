import type { LibraryCategory } from '../core/library-organization.js';
import { readOptionalJson, writeOptionalStorage } from './optional-storage.js';
import {
  readPresentationSetting,
  removePresentationSetting,
  writePresentationSetting,
} from './presentation-settings.js';

const collapsedFoldersKey = 'uimori:library-collapsed-folders';

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

export function readCollapsedFolders(): string[] {
  try {
    const stored = JSON.parse(readPresentationSetting(collapsedFoldersKey) ?? '[]') as unknown;
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function saveCollapsedFolders(ids: string[]) {
  if (ids.length) writePresentationSetting(collapsedFoldersKey, JSON.stringify(ids));
  else removePresentationSetting(collapsedFoldersKey);
}
