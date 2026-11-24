import {
  readOptionalJson,
  removeOptionalStorage,
  writeOptionalStorage,
} from './optional-storage.js';

type Change = { path: string; value: unknown };

export function storyUiDraftChanges(before: unknown, after: unknown, path = ''): Change[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    return after.flatMap((value, index) =>
      storyUiDraftChanges(before[index], value, `${path}/${index}`)
    );
  }
  if (after && typeof after === 'object' && !Array.isArray(after)) {
    const previous = before && typeof before === 'object' ? before : {};
    return Object.entries(after).flatMap(([key, value]) =>
      storyUiDraftChanges(
        (previous as Record<string, unknown>)[key],
        value,
        `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`
      )
    );
  }
  return [{ path: path || '/', value: after }];
}

export function readStoryUiDraft(key: string): Change[] {
  const stored = readOptionalJson('session', key, []);
  return Array.isArray(stored)
    ? stored.filter(
        (item) =>
          item &&
          typeof item.path === 'string' &&
          item.path.startsWith('/') &&
          Object.hasOwn(item, 'value')
      )
    : [];
}

export function writeStoryUiDraft(key: string, changes: Change[]): boolean {
  if (changes.length) return writeOptionalStorage('session', key, JSON.stringify(changes));
  removeOptionalStorage('session', key);
  return true;
}
