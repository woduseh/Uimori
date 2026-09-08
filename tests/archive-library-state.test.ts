import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { Store } from '../server/store.js';
import {
  defaultPromptWorkspace,
  promptWorkspace,
  updatePromptWorkspace,
} from '../server/prompt-workspace.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { deleteLibraryItem } from '../server/library-deletion.js';

const owned: { path: string; store: Store }[] = [];
function database() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-archive-library-'));
  const store = new Store(join(path, 'story.sqlite'));
  owned.push({ path, store });
  return store;
}
afterEach(() => {
  for (const { path, store } of owned.splice(0)) {
    store.close();
    const relativePath = relative(resolve(tmpdir()), resolve(path));
    if (
      isAbsolute(relativePath) ||
      relativePath.startsWith('..') ||
      !basename(path).startsWith('uimori-archive-library-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
test('only default working content counts as empty; explicit reset preserves import eligibility', () => {
  const store = database();
  expect(store.product.importStatus().canImport).toBe(true);
  const original = promptWorkspace(store);
  updatePromptWorkspace(store, {
    expectedRevision: original.revision,
    main: {
      title: 'My unsaved writer',
      program: createDefaultPromptProgram('Keep this authored instruction'),
      values: {},
    },
  });
  const custom = promptWorkspace(store);
  expect(store.product.importStatus().canImport).toBe(false);
  expect(() => store.product.import(database().product.export())).toThrow('empty database');
  expect(promptWorkspace(store)).toEqual(custom);
  updatePromptWorkspace(store, { expectedRevision: custom.revision, main: original.main });
  expect(promptWorkspace(store).revision).toBeGreaterThan(1);
  expect(store.product.importStatus().canImport).toBe(true);
});
test('archive requires one working slot and validates hidden kind and retained target before committing', () => {
  const archive = database().product.export();
  const attacks = [
    (a: typeof archive) => {
      a.tables.prompt_workspace = [];
    },
    (a: typeof archive) => {
      a.tables.prompt_workspace.push({ ...a.tables.prompt_workspace[0] });
    },
    (a: typeof archive) => {
      a.tables.library_hidden.push({ kind: 'unknown', id: 'missing' });
    },
    (a: typeof archive) => {
      a.tables.library_hidden.push({ kind: 'content', id: 'missing' });
    },
    (a: typeof archive) => {
      a.tables.library_hidden.push({ kind: 'asset', id: 'missing' });
    },
    (a: typeof archive) => {
      const row = a.tables.prompt_workspace[0];
      const value = JSON.parse(row.body);
      value.translationPolicy.refusalModel = { id: 'missing' };
      row.body = JSON.stringify(value);
    },
  ];
  for (const attack of attacks) {
    const damaged = structuredClone(archive);
    attack(damaged);
    const target = database();
    expect(() => target.product.import(damaged)).toThrow();
    expect(promptWorkspace(target)).toEqual(defaultPromptWorkspace());
    expect(target.db.prepare('SELECT * FROM library_hidden').all()).toEqual([]);
  }
});
test('independent option copies and removed library entries round-trip without a live preset dependency', () => {
  const source = database();
  const program = createDefaultPromptProgram('Working prompt');
  program.controls = [{ id: 'tone', label: 'Tone', type: 'text', default: 'quiet' }];
  updatePromptWorkspace(source, {
    expectedRevision: 1,
    main: { title: 'Working', program, values: { tone: 'quiet' } },
  });
  const options = source.product.promptCombination({
    title: 'Saved options',
    role: 'main',
    values: { tone: 'bold' },
  });
  const content = source.product.content({
    kind: 'module',
    title: 'Removed module',
    description: '',
    text: 'Retained historical body',
    loading: 'pinned',
    relatedIds: [],
  });
  deleteLibraryItem(source, 'content', content.id, { expectedRevision: 1 });
  const archive = source.product.export(),
    before = structuredClone(archive),
    target = database();
  expect(target.product.import(archive)).toMatchObject({ restored: true });
  expect(archive).toEqual(before);
  expect(target.product.get('prompt-combination', options.id)).toEqual(options);
  expect(target.product.all('content')).toEqual([]);
  expect(target.product.get('content', content.id, 1)).toEqual(content);
  expect(promptWorkspace(target)).toEqual(promptWorkspace(source));
});
