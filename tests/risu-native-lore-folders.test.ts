import { expect, test } from 'vitest';
import type { RisuContentSource } from '../core/risu-native.js';
import { projectNativeRisuPackage } from '../server/risu-native-projection.js';

test.each(['card', 'module'] as const)(
  '%s lore folders stay in the native document without becoming runtime lore',
  (format) => {
    const folderKey = '\uf000folder:parent';
    const childFolderKey = '\uf000folder:nested';
    const records = [
      { key: folderKey, comment: 'Parent', mode: 'folder', content: '@@activate\nFOLDER_BODY' },
      {
        key: childFolderKey,
        comment: 'Nested',
        mode: 'folder',
        folder: folderKey,
        content: 'NESTED_FOLDER_BODY',
        alwaysActive: true,
      },
      {
        key: 'moon',
        comment: 'Child',
        mode: 'normal',
        folder: childFolderKey,
        content: 'CHILD_LORE',
        alwaysActive: false,
      },
    ];
    const native: RisuContentSource = {
      version: 1,
      card: { name: 'Folder test' },
      assets: [],
      sourceHash: 'a'.repeat(64),
      ...(format === 'module' ? { module: { name: 'Folder test', lorebook: records } } : {}),
    };
    if (format === 'card')
      native.card.character_book = {
        entries: records.map(({ key, comment, alwaysActive, ...record }) => ({
          ...record,
          keys: [key],
          name: comment,
          constant: alwaysActive === true,
          enabled: true,
          extensions: { custom: 'preserved' },
        })),
      };
    const before = structuredClone(native);
    const result = projectNativeRisuPackage(
      {
        version: 2,
        id: 'folder-test',
        revision: 1,
        title: 'Folder test',
        description: '',
        lore: [],
        nativeRisu: native,
      },
      'bot'
    );
    expect(result.pkg.nativeRisu).toEqual(before);
    expect(native).toEqual(before);
    expect(result.lore.map((entry) => entry.enabled)).toEqual([false, false, true]);
    expect(result.pkg.lore).toEqual([
      expect.objectContaining({ id: 'lore-2', text: 'CHILD_LORE', loading: 'discoverable' }),
    ]);
  }
);
