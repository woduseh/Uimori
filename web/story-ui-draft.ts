type Change = { path: string; value: unknown };

/** Only local input changes; never copy translated labels or mutate canonical story data. */
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
  try {
    const stored = JSON.parse(sessionStorage.getItem(key) ?? '[]');
    return Array.isArray(stored)
      ? stored.filter(
          (item) =>
            item &&
            typeof item.path === 'string' &&
            item.path.startsWith('/') &&
            Object.hasOwn(item, 'value')
        )
      : [];
  } catch {
    return [];
  }
}

export function writeStoryUiDraft(key: string, changes: Change[]) {
  try {
    if (changes.length) sessionStorage.setItem(key, JSON.stringify(changes));
    else sessionStorage.removeItem(key);
  } catch {
    /* Session recovery may be unavailable; the mounted input still owns its draft. */
  }
}
