import { expect, test } from 'vitest';
import {
  loreParents,
  loreFolderKey,
  moveLoreEntry,
  newLoreEntry,
  removeLoreFolder,
} from '../web/native-lore-document.js';

test('folder relationships use native opaque keys and leave orphans/cycles visible', () => {
  const entries = [
    { mode: 'folder', keys: ['\uf000folder:root'] },
    { mode: 'folder', key: '\uf000folder:child', folder: '\uf000folder:root' },
    { content: 'leaf', folder: '\uf000folder:child' },
    { content: 'orphan', folder: 'missing' },
    { mode: 'folder', key: 'cycle-a', folder: 'cycle-b' },
    { mode: 'folder', key: 'cycle-b', folder: 'cycle-a' },
  ];
  expect(loreParents(entries)).toEqual([null, 0, 1, null, null, null]);
  expect(entries[3].folder).toBe('missing');
});

test('drag movement reorders siblings and reparents entries without changing source fields', () => {
  const entries = [
    { mode: 'folder', key: 'world', comment: 'World', unknown: 'folder' },
    { content: 'city', folder: 'world', unknown: 'city' },
    { content: 'forest', folder: 'world', unknown: 'forest' },
    { mode: 'folder', key: 'people', comment: 'People' },
    { content: 'guard', folder: 'people', unknown: 'guard' },
    { content: 'root', unknown: 'root' },
  ];
  const reordered = moveLoreEntry(entries, 2, 1, 'before')!;
  expect(reordered.index).toBe(1);
  expect(reordered.entries.map((entry) => entry.content ?? entry.comment)).toEqual([
    'World',
    'forest',
    'city',
    'People',
    'guard',
    'root',
  ]);
  expect(reordered.entries[1]).toEqual(entries[2]);

  const nested = moveLoreEntry(entries, 5, 0, 'inside')!;
  expect(nested.entries[nested.index]).toEqual({
    content: 'root',
    unknown: 'root',
    folder: 'world',
  });
  const rooted = moveLoreEntry(entries, 4, null, 'root')!;
  expect(rooted.entries[rooted.index]).toEqual({ content: 'guard', unknown: 'guard' });
  expect(entries[4]).toHaveProperty('folder', 'people');
});

test('drag movement rejects self and descendant folder targets', () => {
  const entries = [
    { mode: 'folder', key: 'root' },
    { mode: 'folder', key: 'child', folder: 'root' },
    { content: 'leaf', folder: 'child' },
  ];
  expect(moveLoreEntry(entries, 0, 1, 'inside')).toBeNull();
  expect(moveLoreEntry(entries, 1, 1, 'before')).toBeNull();
  expect(moveLoreEntry(entries, 2, 0, 'inside')?.entries[2]).toMatchObject({ folder: 'root' });
  expect(
    moveLoreEntry([{ mode: 'folder', comment: 'missing key' }, { content: 'leaf' }], 1, 0, 'inside')
  ).toBeNull();
  expect(
    moveLoreEntry(
      [
        { mode: 'folder', key: 'duplicate', comment: 'first' },
        { mode: 'folder', key: 'duplicate', comment: 'second' },
        { content: 'leaf' },
      ],
      2,
      1,
      'inside'
    )
  ).toBeNull();
});

test('reordering visible root entries does not normalize orphan or empty folder fields', () => {
  const entries = [
    { content: 'orphan', folder: 'missing', unknown: true },
    { content: 'root', folder: '' },
    { content: 'plain' },
  ];
  const moved = moveLoreEntry(entries, 0, 2, 'after')!;
  expect(moved.entries[moved.index]).toEqual(entries[0]);
  expect(entries[1]).toHaveProperty('folder', '');
});

test('deleting a folder reparents children while preserving content, flags and unknown source fields', () => {
  const entries = [
    { mode: 'folder', key: 'root' },
    { mode: 'folder', key: 'child', folder: 'root' },
    {
      content: '@@activate\nsecret',
      folder: 'child',
      unknown: { authored: true },
      alwaysActive: false,
    },
    { content: 'unrelated', folder: 'root' },
  ];
  const next = removeLoreFolder(entries, 1);
  expect(next).toEqual([entries[0], { ...entries[2], folder: 'root' }, entries[3]]);
  expect(entries[2].folder).toBe('child');
  expect(removeLoreFolder(next, 0)).toEqual([
    { content: '@@activate\nsecret', unknown: { authored: true }, alwaysActive: false },
    { content: 'unrelated' },
  ]);
});

test('new card and module folders retain their native representation and unique keys', () => {
  const card = newLoreEntry([{ id: 17 }], false, true);
  const module = newLoreEntry([], true, true);
  expect(card).toMatchObject({ mode: 'folder', id: 18, name: '새 폴더', enabled: true });
  expect(Array.isArray(card.keys)).toBe(true);
  expect(module).toMatchObject({ mode: 'folder', comment: '새 폴더', alwaysActive: false });
  expect(newLoreEntry([], true)).toMatchObject({ secondkey: '', selective: false });
  expect(loreFolderKey(card)).toMatch(/^\uf000folder:/u);
  expect(loreFolderKey(card)).not.toBe(loreFolderKey(module));
});
