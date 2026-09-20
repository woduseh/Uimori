import { expect, test } from 'vitest';
import {
  loreParents,
  loreFolderKey,
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
