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

export type LoreDropPosition = 'before' | 'after' | 'inside' | 'root';

/** Reorder or reparent one native entry without rewriting opaque folder keys or unrelated fields. */
export function moveLoreEntry(
  entries: LoreEntry[],
  sourceIndex: number,
  targetIndex: number | null,
  position: LoreDropPosition
): { entries: LoreEntry[]; index: number } | null {
  const source = entries[sourceIndex];
  if (!source || (targetIndex !== null && !entries[targetIndex]) || sourceIndex === targetIndex)
    return null;
  const parents = loreParents(entries);
  const folderOwners = new Map<string, number>();
  entries.forEach((entry, index) => {
    const key = loreFolderKey(entry);
    if (isLoreFolder(entry) && key && !folderOwners.has(key)) folderOwners.set(key, index);
  });
  let parentIndex: number | null;
  if (position === 'root') parentIndex = null;
  else if (position === 'inside') {
    if (targetIndex === null || !isLoreFolder(entries[targetIndex])) return null;
    const key = loreFolderKey(entries[targetIndex]);
    if (!key || folderOwners.get(key) !== targetIndex) return null;
    parentIndex = targetIndex;
  } else {
    if (targetIndex === null) return null;
    parentIndex = parents[targetIndex];
  }
  if (isLoreFolder(source) && parentIndex !== null) {
    let cursor: number | null = parentIndex;
    const visited = new Set<number>();
    while (cursor !== null) {
      if (cursor === sourceIndex) return null;
      if (visited.has(cursor)) return null;
      visited.add(cursor);
      cursor = folderOwners.get(loreText(entries[cursor].folder)) ?? null;
    }
  }
  const moved = { ...source };
  if (parentIndex === null) {
    if (position === 'root' || parents[sourceIndex] !== null) delete moved.folder;
  } else moved.folder = loreFolderKey(entries[parentIndex]);

  let anchor = targetIndex;
  if (position === 'inside' && targetIndex !== null) {
    const children = entries
      .map((_, index) => index)
      .filter((index) => parents[index] === targetIndex);
    anchor = children.at(-1) ?? targetIndex;
  } else if (position === 'root') {
    const roots = entries.map((_, index) => index).filter((index) => parents[index] === null);
    anchor = roots.at(-1) ?? null;
  }

  const next = [...entries];
  next.splice(sourceIndex, 1);
  let insertion = anchor === null ? next.length : anchor + (position === 'before' ? 0 : 1);
  if (anchor !== null && sourceIndex < insertion) insertion -= 1;
  insertion = Math.max(0, Math.min(insertion, next.length));
  next.splice(insertion, 0, moved);
  if (insertion === sourceIndex && loreText(source.folder) === loreText(moved.folder)) return null;
  return { entries: next, index: insertion };
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
