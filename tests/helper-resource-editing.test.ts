import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { Content } from '../core/product.js';
import { editableResource } from '../core/resource-editing.js';
import { readHelperEditor } from '../server/helper-resource-editing.js';
import { invokeResourceTool } from '../server/helper-resource-tools.js';
import { Store } from '../server/store.js';
import { fixtureBotInput } from './fixtures/chat.js';

const owned: { store: Store; path: string }[] = [];
afterEach(() => {
  for (const { store, path } of owned.splice(0)) {
    store.close();
    const inside = relative(tmpdir(), path);
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !inside.startsWith('uimori-resource-edit-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function fixture(large = false) {
  const path = mkdtempSync(join(tmpdir(), 'uimori-resource-edit-'));
  const store = new Store(join(path, 'test.sqlite'));
  owned.push({ store, path });
  const input = fixtureBotInput('Native owner', large ? 'Body '.repeat(272_000) : 'Body');
  input.package.nativeRisu.card.character_book = {
    entries: [
      {
        comment: 'Harbor',
        keys: ['dock'],
        content: 'Unique blue harbor.',
        enabled: true,
        constant: true,
        extensions: { unfamiliar: 'preserve exactly' },
      },
      { comment: 'Forest', keys: ['pine'], content: 'Green forest.', enabled: true },
    ],
  };
  input.package.nativeRisu.card.extensions = {
    risuai: { other: 'keep' },
    vendor: { sentinel: 17 },
  };
  const content = store.product.content(input) as Content;
  return { store, content };
}
const call = (store: Store, name: string, args: Record<string, unknown>) =>
  invokeResourceTool(store, name, args) as Record<string, any>;

test('captured unsaved editor uses bounded typed paths while preserving its original revision', () => {
  const { store, content } = fixture(true);
  const model = editableResource('content', content);
  const draft = model as Record<string, any>;
  draft.package.nativeRisu.card.description = 'Unsaved fact. ' + 'draft '.repeat(12_000);
  draft.package.nativeRisu.card.character_book = null;
  draft.package.nativeRisu.card.extensions.vendor = { enabled: false, count: 0, empty: [] };
  const editor = {
    kind: 'content' as const,
    targetId: content.id,
    revision: content.revision,
    title: content.title,
    source: 'unsaved' as const,
    model,
  };
  const overview = readHelperEditor(editor, { kind: 'editor' }) as Record<string, any>;
  expect(JSON.stringify(overview).length).toBeLessThan(24_000);
  expect(overview).toMatchObject({
    id: content.id,
    revision: content.revision,
    inputOrigin: 'unsaved-device-editor',
    source: { path: '/package/nativeRisu/card' },
  });
  const path = '/package/nativeRisu/card';
  expect(readHelperEditor(editor, { path: `${path}/character_book` })).toMatchObject({
    type: 'null',
    value: null,
  });
  const fields = readHelperEditor(editor, {
    path: `${path}/extensions/vendor`,
    fields: ['enabled', 'count', 'empty'],
  }) as Record<string, any>;
  expect(fields.fields.map(({ value }: { value: unknown }) => value)).toEqual([false, 0, []]);
  const first = readHelperEditor(editor, { path: `${path}/description`, textLimit: 20 }) as Record<
    string,
    any
  >;
  expect(first.text.startsWith('Unsaved fact.')).toBe(true);
  expect(first.nextOffset).toBe(20);
  expect(JSON.stringify(first)).not.toContain(
    'draft draft draft draft draft draft draft draft draft draft'
  );
  store.product.content(
    { ...fixtureBotInput('Later saved value', 'Saved fact'), expectedRevision: content.revision },
    content.id
  );
  expect(
    (readHelperEditor(editor, { path: `${path}/description`, textLimit: 20 }) as any).text
  ).toBe(first.text);
});

test('small native edit of a 1.36m character card preserves source and refreshes projection with one undo', () => {
  const { store, content } = fixture(true);
  const before = content.package.nativeRisu.card.description;
  const overview = call(store, 'resource.read', { kind: 'content', id: content.id });
  expect(JSON.stringify(overview).length).toBeLessThan(24_000);
  expect(overview.source).toMatchObject({
    path: '/package/nativeRisu/card',
    lorePath: '/package/nativeRisu/card/character_book/entries',
  });
  const patch = call(store, 'resource.patch', {
    kind: 'content',
    id: content.id,
    expectedRevision: overview.revision,
    changes: [
      {
        path: '/package/nativeRisu/card/character_book/entries/0/content',
        op: 'replaceText',
        oldText: 'blue',
        newText: 'silver',
      },
    ],
  });
  expect(patch).toEqual({
    id: content.id,
    revision: content.revision + 1,
    changedPaths: ['/package/nativeRisu/card/character_book/entries/0/content'],
  });
  const saved = store.product.get<Content>('content', content.id);
  const entry = (saved.package.nativeRisu.card.character_book as { entries: Record<string, any>[] })
    .entries[0]!;
  expect(entry.content).toBe('Unique silver harbor.');
  expect(entry.extensions).toEqual({ unfamiliar: 'preserve exactly' });
  expect(saved.package.nativeRisu.card.description).toBe(before);
  expect(saved.package.nativeRisu.card.extensions).toEqual({
    risuai: { other: 'keep' },
    vendor: { sentinel: 17 },
  });
  expect(saved.package.lore[0]?.text).toBe('Unique silver harbor.');
  expect(
    store.db
      .prepare('SELECT saved_revision FROM resource_undo WHERE kind=? AND id=?')
      .get('content', content.id)?.saved_revision
  ).toBe(patch.revision);
  const noop = call(store, 'resource.patch', {
    kind: 'content',
    id: content.id,
    expectedRevision: patch.revision,
    changes: [
      {
        path: '/package/nativeRisu/card/character_book/entries/0/content',
        op: 'set',
        value: 'Unique silver harbor.',
      },
    ],
  });
  expect(noop).toEqual({ id: content.id, revision: patch.revision, changedPaths: [] });
});

test('stale revision and ambiguous literal reject the complete proposal', () => {
  const { store, content } = fixture();
  expect(() =>
    call(store, 'resource.patch', {
      kind: 'content',
      id: content.id,
      expectedRevision: content.revision + 1,
      changes: [{ path: '/package/nativeRisu/card/name', op: 'set', value: 'Wrong' }],
    })
  ).toThrow('저장된 자료가 변경됐어요');
  expect(() =>
    call(store, 'resource.patch', {
      kind: 'content',
      id: content.id,
      expectedRevision: content.revision,
      changes: [
        { path: '/package/nativeRisu/card/name', op: 'set', value: 'Partial' },
        {
          path: '/package/nativeRisu/card/character_book/entries/0/content',
          op: 'replaceText',
          oldText: 'r',
          newText: 'x',
        },
      ],
    })
  ).toThrow('정확히 한 번');
  const saved = store.product.get<Content>('content', content.id);
  expect(saved.title).toBe('Native owner');
  expect(saved.revision).toBe(content.revision);
  expect(() =>
    call(store, 'resource.patch', {
      kind: 'content',
      id: content.id,
      expectedRevision: content.revision,
      changes: [{ path: '/package/nativeRisu/assets', op: 'set', value: [] }],
    })
  ).toThrow('native 원문 필드만');
});

test('field and item pages expose typed values, optional paths and exact UTF-16 text continuation', () => {
  const { store, content } = fixture();
  const base = { kind: 'content', id: content.id };
  const entryPath = '/package/nativeRisu/card/character_book/entries/0';
  const selected = call(store, 'resource.read', {
    ...base,
    path: entryPath,
    fields: ['constant', 'keys', 'secondary_keys'],
  });
  expect(selected.fields).toMatchObject([
    { name: 'constant', value: true, path: `${entryPath}/constant` },
    { name: 'keys', type: 'array', count: 1, value: ['dock'], path: `${entryPath}/keys` },
    { name: 'secondary_keys', exists: false, path: `${entryPath}/secondary_keys` },
  ]);
  const patched = call(store, 'resource.patch', {
    ...base,
    expectedRevision: content.revision,
    changes: [
      { path: `${entryPath}/constant`, op: 'set', value: false },
      { path: `${entryPath}/keys`, op: 'set', value: ['dock', 'pier'] },
      { path: `${entryPath}/secondary_keys`, op: 'set', value: ['harbor'] },
    ],
  });
  expect(patched.changedPaths).toHaveLength(3);
  expect(call(store, 'resource.read', { ...base, path: `${entryPath}/constant` }).value).toBe(
    false
  );
  expect(
    call(store, 'resource.read', { ...base, path: `${entryPath}/secondary_keys/0` }).text
  ).toBe('harbor');
  const page = call(store, 'resource.read', {
    ...base,
    path: '/package/nativeRisu/card/character_book/entries',
    limit: 1,
  });
  expect(page.items[0].path).toBe(entryPath);
  expect(page.items[0].preview).toEqual({
    comment: 'Harbor',
    keys: ['dock', 'pier'],
    secondary_keys: ['harbor'],
  });
  expect(page.nextOffset).toBe(1);
  expect(
    call(store, 'resource.read', {
      ...base,
      path: '/package/nativeRisu/card/character_book/entries',
      offset: page.nextOffset,
      limit: 1,
    }).items[0].path
  ).toBe('/package/nativeRisu/card/character_book/entries/1');
  const big = 'a'.repeat(4_001) + '😀' + 'b'.repeat(100);
  const next = call(store, 'resource.patch', {
    ...base,
    expectedRevision: patched.revision,
    changes: [{ path: `${entryPath}/content`, op: 'set', value: big }],
  });
  const first = call(store, 'resource.read', {
    ...base,
    path: `${entryPath}/content`,
    textLimit: 4_002,
  });
  const second = call(store, 'resource.read', {
    ...base,
    path: `${entryPath}/content`,
    textOffset: first.nextOffset,
    textLimit: 200,
  });
  expect(first.text + second.text === big).toBe(true);
  expect(first.nextOffset).toBe(4_001);
  expect(second.revision).toBe(next.revision);
  const escapedPath = '/package/nativeRisu/card/extensions/vendor/sentinel';
  const escaped = '\u0001'.repeat(5_000);
  const escapedEdit = call(store, 'resource.patch', {
    ...base,
    expectedRevision: next.revision,
    changes: [{ path: escapedPath, op: 'set', value: escaped }],
  });
  const escapedFirst = call(store, 'resource.read', { ...base, path: escapedPath });
  expect(JSON.stringify(escapedFirst).length).toBeLessThanOrEqual(24_000);
  expect(escapedFirst.nextOffset).toBeGreaterThan(0);
  const escapedSecond = call(store, 'resource.read', {
    ...base,
    path: escapedPath,
    textOffset: escapedFirst.nextOffset,
  });
  expect(escapedFirst.text + escapedSecond.text === escaped).toBe(true);
  expect(escapedSecond.revision).toBe(escapedEdit.revision);
  expect(
    call(store, 'resource.read', { ...base, path: `${entryPath}/content`, textOffset: big.length })
  ).toMatchObject({ text: '', textOffset: big.length, nextOffset: null });
  const emptyEdit = call(store, 'resource.patch', {
    ...base,
    expectedRevision: escapedEdit.revision,
    changes: [{ path: '/package/nativeRisu/card/first_mes', op: 'set', value: '' }],
  });
  expect(
    call(store, 'resource.read', { ...base, path: '/package/nativeRisu/card/first_mes' })
  ).toMatchObject({
    revision: emptyEdit.revision,
    text: '',
    length: 0,
    textOffset: 0,
    nextOffset: null,
  });
});

test('overview tolerates a card without a character book', () => {
  const { store } = fixture();
  const input = fixtureBotInput('No lore');
  input.package.nativeRisu.card.character_book = null;
  const content = store.product.content(input) as Content;
  const overview = call(store, 'resource.read', { kind: 'content', id: content.id });
  expect(overview.source.lorePath).toBe('/package/nativeRisu/card/character_book/entries');
  expect(
    overview.regions.some((region: { path: string }) => region.path === overview.source.lorePath)
  ).toBe(false);
});

test('standalone module overview and patch use its authored lorebook', () => {
  const path = mkdtempSync(join(tmpdir(), 'uimori-resource-edit-'));
  const store = new Store(join(path, 'module.sqlite'));
  owned.push({ store, path });
  const input = fixtureBotInput('Fixture module');
  input.package.nativeRisu.card = {};
  input.package.nativeRisu.module = {
    name: 'Fixture module',
    description: 'Module notes',
    lorebook: [{ comment: 'Port', key: 'dock', content: 'Original port.', enabled: true }],
    extensions: { vendor: { unchanged: true } },
  };
  const module = store.product.content({ ...input, kind: 'module' }) as Content;
  const overview = call(store, 'resource.read', { kind: 'content', id: module.id });
  expect(overview.source).toEqual({
    path: '/package/nativeRisu/module',
    lorePath: '/package/nativeRisu/module/lorebook',
    translationGuidePath: '/package/nativeRisu/module/extensions/uimori/translationGuide',
  });
  const updated = call(store, 'resource.patch', {
    kind: 'content',
    id: module.id,
    expectedRevision: overview.revision,
    changes: [
      { path: '/package/nativeRisu/module/lorebook/0/content', op: 'set', value: 'Revised port.' },
    ],
  });
  expect(updated.revision).toBe(module.revision + 1);
  const saved = store.product.get<Content>('content', module.id);
  expect(saved.package.nativeRisu.module).toMatchObject({
    lorebook: [{ content: 'Revised port.' }],
  });
  expect(saved.package.lore[0]?.text).toBe('Revised port.');
  expect(saved.package.nativeRisu.card).toEqual({});
  expect(saved.package.nativeRisu.module?.extensions).toEqual({ vendor: { unchanged: true } });
});

test('creates a guide and edits one term without changing adjacent native fields', () => {
  const { store, content } = fixture();
  const guide = '/package/nativeRisu/card/extensions/uimori/translationGuide';
  const created = call(store, 'resource.patch', {
    kind: 'content',
    id: content.id,
    expectedRevision: content.revision,
    changes: [
      { path: guide, op: 'set', value: { instructions: 'Keep the harbor name.', terms: [] } },
    ],
  });
  const inserted = call(store, 'resource.patch', {
    kind: 'content',
    id: content.id,
    expectedRevision: created.revision,
    changes: [
      { path: `${guide}/terms/0`, op: 'insert', value: { source: 'Harbor', target: '항구' } },
    ],
  });
  const edited = call(store, 'resource.patch', {
    kind: 'content',
    id: content.id,
    expectedRevision: inserted.revision,
    changes: [{ path: `${guide}/terms/0/target`, op: 'set', value: '해항' }],
  });
  const saved = store.product.get<Content>('content', content.id);
  expect((saved.package.nativeRisu.card.extensions as any).uimori.translationGuide).toEqual({
    instructions: 'Keep the harbor name.',
    terms: [{ source: 'Harbor', target: '해항' }],
  });
  expect(saved.package.nativeRisu.card.extensions).toMatchObject({
    risuai: { other: 'keep' },
    vendor: { sentinel: 17 },
  });
  const replaced = call(store, 'resource.patch', {
    kind: 'content',
    id: content.id,
    expectedRevision: edited.revision,
    changes: [
      {
        path: guide,
        op: 'set',
        value: {
          instructions: 'Use the revised spelling.',
          terms: [{ source: 'Harbor', target: '항만' }],
        },
      },
    ],
  });
  expect(
    (store.product.get<Content>('content', content.id).package.nativeRisu.card.extensions as any)
      .uimori.translationGuide
  ).toEqual({
    instructions: 'Use the revised spelling.',
    terms: [{ source: 'Harbor', target: '항만' }],
  });
  const removed = call(store, 'resource.patch', {
    kind: 'content',
    id: content.id,
    expectedRevision: replaced.revision,
    changes: [{ path: `${guide}/terms/0`, op: 'remove' }],
  });
  expect(
    call(store, 'resource.read', {
      kind: 'content',
      id: content.id,
      path: `${guide}/terms`,
    })
  ).toMatchObject({ revision: removed.revision, count: 0, items: [] });
});

test('inserting and removing lore preserves authored neighbors and refreshes the projection', () => {
  const { store, content } = fixture();
  const entries = '/package/nativeRisu/card/character_book/entries';
  const inserted = call(store, 'resource.patch', {
    kind: 'content',
    id: content.id,
    expectedRevision: content.revision,
    changes: [
      {
        path: `${entries}/1`,
        op: 'insert',
        value: {
          comment: 'River',
          keys: ['river'],
          content: 'River crossing.',
          enabled: true,
          extensions: { vendor: { placement: 'keep' } },
        },
      },
    ],
  });
  let saved = store.product.get<Content>('content', content.id);
  expect(
    (saved.package.nativeRisu.card.character_book as any).entries.map((entry: any) => entry.comment)
  ).toEqual(['Harbor', 'River', 'Forest']);
  expect(saved.package.lore.map((entry) => entry.title)).toContain('River');
  expect(() =>
    call(store, 'resource.patch', {
      kind: 'content',
      id: content.id,
      expectedRevision: content.revision,
      changes: [{ path: `${entries}/0`, op: 'remove' }],
    })
  ).toThrow('저장된 자료가 변경됐어요');
  const removed = call(store, 'resource.patch', {
    kind: 'content',
    id: content.id,
    expectedRevision: inserted.revision,
    changes: [{ path: `${entries}/1`, op: 'remove' }],
  });
  saved = store.product.get<Content>('content', content.id);
  expect((saved.package.nativeRisu.card.character_book as any).entries).toEqual(
    (content.package.nativeRisu.card.character_book as any).entries
  );
  expect(saved.package.lore.map((entry) => entry.title)).not.toContain('River');
  expect(removed.changedPaths).toEqual([`${entries}/1`]);
});

test('preset native text and option declarations patch through normal preset validation', () => {
  const path = mkdtempSync(join(tmpdir(), 'uimori-resource-edit-'));
  const store = new Store(join(path, 'preset.sqlite'));
  owned.push({ store, path });
  const preset = store.product.promptPreset({
    title: 'Draft',
    role: 'main',
    text: 'Original instruction.',
  });
  const blocks = '/program/nativeRisuPreset/preset/promptTemplate';
  const block = call(store, 'resource.read', {
    kind: 'prompt-preset',
    id: preset.id,
    path: blocks,
    limit: 1,
  }).items[0].path as string;
  const source = call(store, 'resource.read', {
    kind: 'prompt-preset',
    id: preset.id,
    path: block,
  });
  const textField = source.fields.find((field: any) => field.name === 'text');
  expect(textField).toBeDefined();
  const edited = call(store, 'resource.patch', {
    kind: 'prompt-preset',
    id: preset.id,
    expectedRevision: preset.revision,
    changes: [
      { path: textField.path, op: 'replaceText', oldText: 'Original', newText: 'Revised' },
      {
        path: '/program/nativeRisuPreset/preset/customPromptTemplateToggle',
        op: 'set',
        value: 'tone=Tone=text',
      },
    ],
  });
  const saved = store.product.get<any>('prompt-preset', preset.id);
  expect(saved.revision).toBe(edited.revision);
  expect((saved.program.nativeRisuPreset.preset.promptTemplate as any[])[0].text).toContain(
    'Revised instruction.'
  );
  expect(saved.program.nativeRisuPreset.preset.customPromptTemplateToggle).toBe('tone=Tone=text');
  expect(saved.values).toHaveProperty('tone');
});

test('first lore insertion creates the missing card book without replacing native source', () => {
  const { store } = fixture();
  const input = fixtureBotInput('New lore owner');
  input.package.nativeRisu.card.character_book = null;
  input.package.nativeRisu.card.extensions = { vendor: { keep: true } };
  const content = store.product.content(input) as Content;
  const inserted = call(store, 'resource.patch', {
    kind: 'content',
    id: content.id,
    expectedRevision: content.revision,
    changes: [
      {
        path: '/package/nativeRisu/card/character_book/entries/0',
        op: 'insert',
        value: { comment: 'First', content: 'First fact.', constant: true, enabled: true },
      },
    ],
  });
  const saved = store.product.get<Content>('content', content.id);
  expect(inserted.revision).toBe(content.revision + 1);
  expect((saved.package.nativeRisu.card.character_book as any).entries).toHaveLength(1);
  expect(saved.package.nativeRisu.card.extensions).toEqual({ vendor: { keep: true } });
  expect(saved.package.lore[0]?.text).toBe('First fact.');
});
