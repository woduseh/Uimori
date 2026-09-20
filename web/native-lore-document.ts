export type LoreEntry = Record<string, unknown>;
export const loreText = (value: unknown): string => (typeof value === 'string' ? value : '');
export const loreTitle = (entry: LoreEntry) =>
  loreText(entry.comment ?? entry.name) || '이름 없는 로어';
export const isLoreFolder = (entry: LoreEntry) => entry.mode === 'folder';
export const loreFolderKey = (entry: LoreEntry) =>
  typeof entry.key === 'string'
    ? entry.key
    : Array.isArray(entry.keys)
      ? entry.keys.join(', ')
      : '';

/** Native folder keys are opaque. Missing parents and cycles stay visible without rewriting source. */
export function loreParents(entries: LoreEntry[]): (number | null)[] {
  const folders = new Map<string, number>();
  entries.forEach((entry, index) => {
    const key = loreFolderKey(entry);
    if (isLoreFolder(entry) && key && !folders.has(key)) folders.set(key, index);
  });
  const parents = entries.map((entry) => folders.get(loreText(entry.folder)) ?? null);
  return parents.map((parent, index) => {
    const visited = new Set([index]);
    let cursor = parent;
    while (cursor !== null) {
      if (visited.has(cursor)) return null;
      visited.add(cursor);
      cursor = parents[cursor];
    }
    return parent;
  });
}

export function removeLoreFolder(entries: LoreEntry[], index: number): LoreEntry[] {
  const key = loreFolderKey(entries[index]);
  const parent = loreText(entries[index].folder);
  return entries
    .filter((_, i) => i !== index)
    .map((entry) => {
      if (!key || entry.folder !== key) return entry;
      const next = { ...entry };
      if (parent && parent !== key) next.folder = parent;
      else delete next.folder;
      return next;
    });
}

export function newLoreEntry(entries: LoreEntry[], moduleLore: boolean, folder = false): LoreEntry {
  const key = folder ? `\uf000folder:${crypto.randomUUID()}` : '';
  const common = { content: '', mode: folder ? 'folder' : 'normal' };
  return moduleLore
    ? {
        ...common,
        comment: folder ? '새 폴더' : '새 로어',
        key,
        insertorder: 100,
        alwaysActive: false,
        secondkey: '',
        selective: false,
      }
    : {
        ...common,
        id:
          Math.max(-1, ...entries.map((entry) => (typeof entry.id === 'number' ? entry.id : -1))) +
          1,
        name: folder ? '새 폴더' : '새 로어',
        keys: key ? [key] : [],
        enabled: true,
        constant: false,
        insertion_order: 100,
      };
}
