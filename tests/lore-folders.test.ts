import { nativeContent } from './fixtures/native-content.js';
import { describe, expect, it } from 'vitest';
import { CONTENT_TARGETS, validateRisuContent, type RisuContent } from '../core/risu-content.js';
import { compileContentAttachment } from '../core/package-runtime.js';

function fixture(): RisuContent {
  return {
    ...nativeContent({ name: 'World', system_prompt: 'Write a scene.' }),
    id: 'world',
    revision: 1,
    title: 'World',
    description: '',
    lore: [
      {
        id: 'city',
        title: 'City',
        description: 'A port',
        text: 'City facts',
        loading: 'pinned',
        relatedIds: ['guild'],
      },
      {
        id: 'guild',
        title: 'Guild',
        description: 'An organization',
        text: 'Guild facts',
        loading: 'discoverable',
      },
    ],
    instructions: [{ id: 'main', target: 'main', text: 'Write a scene.' }],
  };
}

describe('package lore organization', () => {
  it('round trips empty folders, membership and unfiled entries without mutating the input', () => {
    const pkg = fixture();
    pkg.loreFolders = [
      { id: 'places', name: '장소' },
      { id: 'unused', name: '빈 폴더' },
    ];
    pkg.lore[0].folderId = 'places';
    const saved = validateRisuContent(JSON.parse(JSON.stringify(pkg)));
    expect(saved).toEqual(pkg);
    saved.loreFolders![0].name = 'Changed';
    expect(pkg.loreFolders[0].name).toBe('장소');
    expect(saved.lore[1].folderId).toBeUndefined();
  });

  it('rejects dangling references, malformed identifiers and duplicate folder IDs', () => {
    const pkg = fixture();
    pkg.lore[0].folderId = 'missing';
    expect(() => validateRisuContent(pkg)).toThrow('PACKAGE_LORE_FOLDER_REFERENCE');
    pkg.loreFolders = [{ id: 'missing', name: 'Exists' }];
    expect(() => validateRisuContent(pkg)).not.toThrow();
    pkg.loreFolders.push({ id: 'missing', name: 'Duplicate' });
    expect(() => validateRisuContent(pkg)).toThrow('PACKAGE_DUPLICATE_ID');
    pkg.loreFolders = [{ id: 'bad id', name: 'Bad' }];
    expect(() => validateRisuContent(pkg)).toThrow('PACKAGE_INVALID_ID');
    pkg.loreFolders = [];
    pkg.lore[0].folderId = '';
    expect(() => validateRisuContent(pkg)).toThrow('PACKAGE_INVALID_ID');
  });

  it('requires trimmed, nonempty folder names with a 100 character limit', () => {
    for (const name of ['', '  ', ' place', 'place ']) {
      expect(() =>
        validateRisuContent({ ...fixture(), loreFolders: [{ id: 'folder', name }] })
      ).toThrow('PACKAGE_LORE_FOLDER_NAME');
    }
    expect(() =>
      validateRisuContent({
        ...fixture(),
        loreFolders: [{ id: 'folder', name: '가'.repeat(100) }],
      })
    ).not.toThrow();
    expect(() =>
      validateRisuContent({
        ...fixture(),
        loreFolders: [{ id: 'folder', name: '가'.repeat(101) }],
      })
    ).toThrow('PACKAGE_INVALID_STRING');
  });

  it('rejects nested folders and unknown metadata fields, and bounds the folder count', () => {
    for (const extra of [{ parentId: 'parent' }, { color: 'red' }]) {
      expect(() =>
        validateRisuContent({
          ...fixture(),
          loreFolders: [{ id: 'folder', name: 'Folder', ...extra }],
        })
      ).toThrow('PACKAGE_INVALID_FIELDS');
    }
    const pkg = fixture();
    pkg.loreFolders = Array.from({ length: 2000 }, (_, i) => ({
      id: `f${i}`,
      name: `Folder ${i}`,
    }));
    expect(() => validateRisuContent(pkg)).not.toThrow();
    pkg.loreFolders.push({ id: 'overflow', name: 'Overflow' });
    expect(() => validateRisuContent(pkg)).toThrow('PACKAGE_LIST_LIMIT');
  });

  it('keeps resources, instructions, order and loading identical across folder moves and renames for every target', () => {
    const bare = fixture(),
      organized = structuredClone(bare);
    organized.loreFolders = [{ id: 'private-folder-id', name: 'AUTHORING_ONLY_FOLDER' }];
    organized.lore[0].folderId = 'private-folder-id';
    for (const target of CONTENT_TARGETS) {
      const ref = { id: bare.id, revision: bare.revision, role: 'module' as const };
      const context = { chatId: 'chat', target };
      const baseline = compileContentAttachment(bare, ref, context);
      expect(compileContentAttachment(organized, ref, context)).toEqual(baseline);
      organized.loreFolders[0].name = 'RENAMED_AUTHORING_FOLDER';
      delete organized.lore[0].folderId;
      organized.lore[1].folderId = 'private-folder-id';
      expect(compileContentAttachment(organized, ref, context)).toEqual(baseline);
      expect(compileContentAttachment(organized, ref, { ...context, resourcesOnly: true })).toEqual(
        compileContentAttachment(bare, ref, { ...context, resourcesOnly: true })
      );
    }
  });
});
