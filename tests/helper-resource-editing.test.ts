import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { Content, PromptPreset } from '../core/product.js';
import { editableResource } from '../core/resource-editing.js';
import { readHelperEditor } from '../server/helper-resource-editing.js';
import { HelperResourcePatchError } from '../server/helper-resource-patch-error.js';
import { invokeResourceTool } from '../server/helper-resource-tools.js';
import { Store } from '../server/store.js';
import { fixtureBotInput } from './fixtures/chat.js';

const owned: { store: Store; path: string }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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
const presetBlocksPath = '/program/nativeRisuPreset/preset/promptTemplate';
function presetFixture(blocks: Record<string, unknown>[]) {
  const { store } = fixture();
  const preset = store.product.promptPreset({
    title: 'Library V1',
    role: 'main',
    program: {
      version: 1,
      nativeRisuPreset: {
        version: 1,
        preset: {
          name: 'Native V1',
          promptTemplate: blocks,
          customPromptTemplateToggle: 'tone=Tone=text',
          templateDefaultVariables: 'tone=quiet',
        },
      },
    },
    values: { tone: 'warm' },
  }) as PromptPreset;
  return { store, preset, target: { kind: 'prompt-preset', id: preset.id } };
}

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

test('batched resource paths load one revision and preserve typed fields and local path errors', () => {
  const { store, content } = fixture();
  const base = { kind: 'content', id: content.id };
  const entry = '/package/nativeRisu/card/character_book/entries/0';
  const vendor = '/package/nativeRisu/card/extensions/vendor';
  const edited = call(store, 'resource.patch', {
    ...base,
    expectedRevision: content.revision,
    changes: [
      { path: `${entry}/constant`, op: 'set', value: false },
      { path: `${vendor}/sentinel`, op: 'set', value: 0 },
    ],
  });
  const load = vi.spyOn(store.product, 'get');
  const batch = call(store, 'resource.read', {
    ...base,
    paths: [entry, vendor, `${entry}/unknown/child`],
    fields: ['constant', 'sentinel', 'missing'],
  });
  expect(load).toHaveBeenCalledTimes(1);
  expect(batch.nextIndex).toBeNull();
  expect(batch.items).toMatchObject([
    {
      ...base,
      revision: edited.revision,
      path: entry,
      fields: [
        { name: 'constant', exists: true, type: 'boolean', value: false },
        { name: 'sentinel', exists: false },
        { name: 'missing', exists: false },
      ],
    },
    {
      ...base,
      revision: edited.revision,
      path: vendor,
      fields: [
        { name: 'constant', exists: false },
        { name: 'sentinel', exists: true, type: 'number', value: 0 },
        { name: 'missing', exists: false },
      ],
    },
    { path: `${entry}/unknown/child`, error: '자료 경로가 존재하지 않아요.' },
  ]);
  expect(() => call(store, 'resource.read', { ...base, path: entry, paths: [vendor] })).toThrow(
    'path와 paths'
  );
  expect(store.product.get<Content>('content', content.id).revision).toBe(edited.revision);
});

test('batched resource reads keep the complete envelope bounded with separate path and text continuation', () => {
  const { store, content } = fixture();
  const base = { kind: 'content', id: content.id };
  const paths = [
    '/package/nativeRisu/card/character_book/entries/0/content',
    '/package/nativeRisu/card/character_book/entries/1/content',
  ];
  const original = '\u0001'.repeat(5_000);
  const edited = call(store, 'resource.patch', {
    ...base,
    expectedRevision: content.revision,
    changes: [{ path: paths[0], op: 'set', value: original }],
  });
  const first = call(store, 'resource.read', { ...base, paths, textLimit: 10_000 });
  expect(JSON.stringify(first).length).toBeLessThanOrEqual(24_000);
  expect(first.nextIndex).toBe(1);
  expect(first.items).toHaveLength(1);
  expect(first.items[0]).toMatchObject({ path: paths[0], revision: edited.revision });
  expect(first.items[0].nextOffset).toBeGreaterThan(0);
  const single = call(store, 'resource.read', {
    ...base,
    paths: paths.slice(0, 1),
    textLimit: 10_000,
  });
  expect(JSON.stringify(single).length).toBeLessThanOrEqual(24_000);
  expect(single.items).toEqual(first.items);
  expect(single.nextIndex).toBeNull();
  const remaining = call(store, 'resource.read', {
    ...base,
    paths: paths.slice(first.nextIndex),
    textLimit: 10_000,
  });
  expect(remaining).toMatchObject({
    items: [{ path: paths[1], revision: edited.revision, text: 'Green forest.', nextOffset: null }],
    nextIndex: null,
  });
  const continuation = call(store, 'resource.read', {
    ...base,
    paths: [paths[0]],
    textOffset: first.items[0].nextOffset,
    textLimit: 10_000,
  });
  expect(continuation).toMatchObject({
    items: [{ path: paths[0], revision: edited.revision, nextOffset: null }],
    nextIndex: null,
  });
  expect(first.items[0].text + continuation.items[0].text).toBe(original);
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

test('preset overview points to a complete 40-block outline without loading authored text', () => {
  const blocks = Array.from({ length: 40 }, (_, index) => ({
    name: `Block ${index}`,
    type: 'plain',
    role: 'system',
    text: `PRIVATE_BODY_${index} `.repeat(100),
    ...(index % 3 ? { id: 'legacy-duplicate' } : {}),
  }));
  const { store, preset, target } = presetFixture([
    {
      type: 'authornote',
      role2: 'user',
      name: 'Author note',
      innerFormat: '<note>{{slot}}</note>',
      defaultText: '초안 😀',
    },
    ...blocks.slice(1),
  ]);
  const overview = call(store, 'resource.read', target);
  expect(overview.readyPaths).toEqual([
    presetBlocksPath,
    '/program/nativeRisuPreset/preset/customPromptTemplateToggle',
    '/program/nativeRisuPreset/preset/templateDefaultVariables',
    '/values',
  ]);
  const outline = call(store, 'resource.read', { ...target, path: presetBlocksPath, limit: 50 });
  expect(outline.revision).toBe(preset.revision);
  expect(outline.items).toHaveLength(40);
  expect(outline.nextOffset).toBeNull();
  expect(outline.items[0]).toMatchObject({
    name: '0',
    path: `${presetBlocksPath}/0`,
    type: 'object',
    block: {
      name: 'Author note',
      type: 'authornote',
      role2: 'user',
      textLengths: { innerFormat: 21, defaultText: 5 },
    },
  });
  expect(outline.items[0].block).not.toHaveProperty('id');
  expect(outline.items[1].block).toEqual({
    id: 'legacy-duplicate',
    name: 'Block 1',
    type: 'plain',
    role: 'system',
    textLengths: { text: 1500 },
  });
  expect(JSON.stringify(outline)).not.toContain('PRIVATE_BODY_');
  expect(JSON.stringify(outline).length).toBeLessThanOrEqual(24_000);
  const next = call(store, 'resource.read', {
    ...target,
    path: presetBlocksPath,
    offset: 39,
    limit: 1,
  });
  expect(next.items[0].path).toBe(`${presetBlocksPath}/39`);
  expect(next.nextOffset).toBeNull();
});

test('oversized block metadata stays paged and offers exact field reads without changing stored text', () => {
  const longName = '긴 이름 "\\\n😀'.repeat(4000);
  const longId = 'legacy-'.repeat(4000);
  const { store, preset, target } = presetFixture([
    { id: longId, name: longName, type: 'plain', role: 'system', text: 'PRIVATE_BODY' },
    { name: 'Short name', type: 'chat' },
    { name: longName, type: 'authornote', defaultText: 'PRIVATE_NOTE' },
  ]);
  const first = call(store, 'resource.read', { ...target, path: presetBlocksPath, limit: 1 });
  expect(first.items).toHaveLength(1);
  expect(first.nextOffset).toBe(1);
  const block = first.items[0].block;
  expect(block).toMatchObject({ type: 'plain', role: 'system', textLengths: { text: 12 } });
  expect(block).not.toHaveProperty('name');
  expect(block).not.toHaveProperty('id');
  expect(block.previews.name).toMatchObject({
    length: longName.length,
    path: `${presetBlocksPath}/0/name`,
  });
  expect(block.previews.name.text.length).toBeLessThanOrEqual(200);
  expect(longName.startsWith(block.previews.name.text)).toBe(true);
  expect(block.previews.id).toMatchObject({
    length: longId.length,
    path: `${presetBlocksPath}/0/id`,
  });
  expect(JSON.stringify(first).length).toBeLessThanOrEqual(24_000);
  expect(JSON.stringify(first)).not.toContain('PRIVATE_BODY');
  const next = call(store, 'resource.read', {
    ...target,
    path: presetBlocksPath,
    offset: first.nextOffset,
  });
  expect(next.items.map((item: any) => item.path)).toEqual([
    `${presetBlocksPath}/1`,
    `${presetBlocksPath}/2`,
  ]);
  expect(next.nextOffset).toBeNull();
  expect(next.items[0].block.name).toBe('Short name');
  expect(next.items[1].block.previews.name.length).toBe(longName.length);
  const exact = call(store, 'resource.read', {
    ...target,
    path: block.previews.name.path,
    textLimit: 37,
  });
  expect(exact.text).toBe(longName.slice(0, exact.nextOffset));
  expect(exact.length).toBe(longName.length);
  expect(store.product.get('prompt-preset', preset.id)).toEqual(preset);
});

test('preset block edits compose sequentially with one save and undo while preserving slot metadata', () => {
  const blocks = [
    { type: 'plain', role: 'system', text: 'Core', extensions: { vendor: [1, 2] } },
    { id: 'duplicate', type: 'chat', rangeStart: 0, rangeEnd: 'end', cachePoint: true },
    {
      id: 'duplicate',
      type: 'persona',
      role2: 'system',
      innerFormat: '<persona>{{slot}}</persona>',
      vendor: { unknown: 'keep' },
    },
    { type: 'plain', role: 'user', name: 'Seal', text: 'Deliver directly.' },
  ];
  const { store, preset, target } = presetFixture(blocks);
  const inserted = { type: 'plain', role: 'user', text: 'Original instruction.' };
  const result = call(store, 'resource.patch', {
    ...target,
    expectedRevision: preset.revision,
    changes: [
      { op: 'insert', path: `${presetBlocksPath}/1`, value: inserted },
      {
        op: 'replaceText',
        path: `${presetBlocksPath}/1/text`,
        oldText: 'Original',
        newText: 'Revised',
      },
      { op: 'move', from: `${presetBlocksPath}/3`, path: `${presetBlocksPath}/0` },
      { op: 'remove', path: `${presetBlocksPath}/4` },
      { op: 'move', from: `${presetBlocksPath}/1`, path: `${presetBlocksPath}/3` },
    ],
  });
  const saved = store.product.get<any>('prompt-preset', preset.id);
  expect(result.revision).toBe(preset.revision + 1);
  expect(saved.program.nativeRisuPreset.preset.promptTemplate).toEqual([
    blocks[2],
    { ...inserted, text: 'Revised instruction.' },
    blocks[1],
    blocks[0],
  ]);
  expect(saved.values).toEqual(preset.values);
  expect(saved.program.nativeRisuPreset.preset.customPromptTemplateToggle).toBe('tone=Tone=text');
  const noChange = call(store, 'resource.patch', {
    ...target,
    expectedRevision: saved.revision,
    changes: [
      { op: 'move', from: `${presetBlocksPath}/0`, path: `${presetBlocksPath}/2` },
      { op: 'move', from: `${presetBlocksPath}/2`, path: `${presetBlocksPath}/0` },
      { op: 'move', from: `${presetBlocksPath}/1`, path: `${presetBlocksPath}/1` },
    ],
  });
  expect(noChange).toEqual({ id: preset.id, revision: saved.revision, changedPaths: [] });
  call(store, 'resource.undo', { ...target, expectedRevision: saved.revision });
  const restored = store.product.get<any>('prompt-preset', preset.id);
  expect(restored).toEqual({ ...preset, revision: preset.revision + 2 });
});

test('preset display title can change independently from the native name and undo normally', () => {
  const { store, preset, target } = presetFixture([{ type: 'plain', text: 'Instruction' }]);
  const saved = call(store, 'resource.patch', {
    ...target,
    expectedRevision: preset.revision,
    changes: [{ op: 'set', path: '/title', value: 'Library V2' }],
  });
  expect(store.product.get<any>('prompt-preset', preset.id)).toEqual({
    ...preset,
    title: 'Library V2',
    revision: saved.revision,
  });
  call(store, 'resource.undo', { ...target, expectedRevision: saved.revision });
  expect(store.product.get<any>('prompt-preset', preset.id)).toEqual({
    ...preset,
    revision: preset.revision + 2,
  });
});

test('stale and invalid preset structural proposals leave every block and the undo record intact', () => {
  const {
    store,
    preset: initial,
    target,
  } = presetFixture([
    { type: 'plain', role: 'system', text: 'Original' },
    { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
  ]);
  call(store, 'resource.patch', {
    ...target,
    expectedRevision: initial.revision,
    changes: [{ op: 'set', path: '/title', value: 'Saved draft' }],
  });
  const preset = store.product.get<any>('prompt-preset', initial.id);
  const previousUndo = store.db
    .prepare('SELECT saved_revision,model FROM resource_undo WHERE kind=? AND id=?')
    .get(target.kind, target.id);
  const insert = { op: 'insert', path: `${presetBlocksPath}/1`, value: { type: 'persona' } };
  expect(() =>
    call(store, 'resource.patch', {
      ...target,
      expectedRevision: preset.revision + 1,
      changes: [insert],
    })
  ).toThrow('저장된 자료가 변경됐어요');
  for (const invalid of [
    { op: 'move', from: `${presetBlocksPath}/0`, path: `${presetBlocksPath}/3` },
    { op: 'move', from: '/values/tone/0', path: `${presetBlocksPath}/1` },
    { op: 'insert', path: '/program/nativeRisuPreset/preset/regex/0', value: {} },
    { op: 'insert', path: `${presetBlocksPath}/0`, value: [] },
    { op: 'set', path: '/title/extra', value: 'Wrong' },
    { op: 'set', path: '/program/nativeRisuPreset/preset/unsupported', value: true },
  ]) {
    expect(() =>
      call(store, 'resource.patch', {
        ...target,
        expectedRevision: preset.revision,
        changes: [insert, invalid],
      })
    ).toThrow();
    expect(store.product.get<any>('prompt-preset', preset.id)).toEqual(preset);
    expect(
      store.db
        .prepare('SELECT saved_revision,model FROM resource_undo WHERE kind=? AND id=?')
        .get(target.kind, target.id)
    ).toEqual(previousUndo);
  }
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

test('original item targets survive insertion, deletion and movement without relying on native IDs', () => {
  const blocks = [
    { type: 'plain', text: 'Core' },
    { id: 'duplicate', type: 'plain', text: 'First duplicate' },
    { id: 'duplicate', type: 'plain', text: 'Second duplicate' },
    { type: 'plain', text: 'Seal' },
  ];
  const { store, preset, target } = presetFixture(blocks);
  const outline = call(store, 'resource.read', { ...target, path: presetBlocksPath });
  expect(outline.items.map((item: any) => item.target)).toEqual(
    blocks.map((_, index) => `${presetBlocksPath}/${index}`)
  );
  const editor = readHelperEditor(
    {
      kind: 'prompt-preset',
      targetId: preset.id,
      revision: preset.revision,
      title: preset.title,
      source: 'saved',
      model: editableResource('prompt-preset', preset),
    },
    { path: presetBlocksPath }
  ) as any;
  expect(editor.items[0]).not.toHaveProperty('target');
  const inserted = { type: 'plain', text: 'Inserted' };
  const result = call(store, 'resource.patch', {
    ...target,
    expectedRevision: preset.revision,
    changes: [
      { op: 'insert', path: `${presetBlocksPath}/0`, value: inserted },
      { op: 'remove', target: outline.items[1].target, path: '' },
      { op: 'move', from: `${presetBlocksPath}/2`, path: `${presetBlocksPath}/0` },
      { op: 'set', target: outline.items[0].target, path: '/text', value: 'Edited core' },
      {
        op: 'replaceText',
        target: outline.items[2].target,
        path: '/text',
        oldText: 'Second',
        newText: 'Edited',
      },
      { op: 'remove', target: outline.items[3].target, path: '' },
    ],
  });
  const saved = store.product.get<any>('prompt-preset', preset.id);
  expect(saved.revision).toBe(preset.revision + 1);
  expect(saved.program.nativeRisuPreset.preset.promptTemplate).toEqual([
    { ...blocks[2], text: 'Edited duplicate' },
    inserted,
    { ...blocks[0], text: 'Edited core' },
  ]);
  call(store, 'resource.undo', { ...target, expectedRevision: result.revision });
  expect(store.product.get<any>('prompt-preset', preset.id)).toEqual({
    ...preset,
    revision: preset.revision + 2,
  });
});

test('missing original targets and previously removed targets reject the entire proposal', () => {
  const { store, preset, target } = presetFixture([{ type: 'plain', text: 'Original' }]);
  call(store, 'resource.patch', {
    ...target,
    expectedRevision: preset.revision,
    changes: [{ op: 'set', path: '/title', value: 'Saved title' }],
  });
  const saved = store.product.get<any>('prompt-preset', preset.id);
  const undo = store.db.prepare('SELECT * FROM resource_undo WHERE id=?').get(preset.id);
  for (const [changes, expected] of [
    [
      [
        { op: 'remove', path: `${presetBlocksPath}/0` },
        { op: 'set', target: `${presetBlocksPath}/0`, path: '/text', value: 'Wrong' },
      ],
      { changeIndex: 1, reason: 'target_removed', target: `${presetBlocksPath}/0` },
    ],
    [
      [
        { op: 'insert', path: `${presetBlocksPath}/1`, value: { type: 'plain', text: 'New' } },
        { op: 'set', target: `${presetBlocksPath}/1`, path: '/text', value: 'Wrong' },
      ],
      { changeIndex: 1, reason: 'target_missing', target: `${presetBlocksPath}/1` },
    ],
    [
      [{ op: 'set', target: '/values/tone', path: '', value: 'Wrong' }],
      { changeIndex: 0, reason: 'invalid_target', target: '/values/tone' },
    ],
  ] as const) {
    let caught: unknown;
    try {
      call(store, 'resource.patch', { ...target, expectedRevision: saved.revision, changes });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HelperResourcePatchError);
    expect(caught).toMatchObject({ details: { ...expected, op: 'set' } });
    expect(store.product.get<any>('prompt-preset', preset.id)).toEqual(saved);
    expect(store.db.prepare('SELECT * FROM resource_undo WHERE id=?').get(preset.id)).toEqual(undo);
  }
});

test('replaceText prefers exact matches and maps unique CRLF equivalents to original byte slices', () => {
  const { store, preset, target } = presetFixture([
    { type: 'plain', text: 'same\nline / same\r\nline' },
    { type: 'plain', text: '앞\r\n😀 A\r\nB\r\nC 뒤\n끝' },
    { type: 'plain', text: 'Start\none\ntwo\nend' },
  ]);
  const result = call(store, 'resource.patch', {
    ...target,
    expectedRevision: preset.revision,
    changes: [
      {
        op: 'replaceText',
        path: `${presetBlocksPath}/0/text`,
        oldText: 'same\nline',
        newText: 'exact',
      },
      {
        op: 'replaceText',
        path: `${presetBlocksPath}/1/text`,
        oldText: 'A\nB\nC',
        newText: 'X\nY\r\nZ',
      },
      {
        op: 'replaceText',
        path: `${presetBlocksPath}/2/text`,
        oldText: 'one\r\ntwo',
        newText: 'Replacement\r\nbytes',
      },
    ],
  });
  expect(
    store.product.get<any>('prompt-preset', preset.id).program.nativeRisuPreset.preset
      .promptTemplate
  ).toEqual([
    { type: 'plain', text: 'exact / same\r\nline' },
    { type: 'plain', text: '앞\r\n😀 X\nY\r\nZ 뒤\n끝' },
    { type: 'plain', text: 'Start\nReplacement\r\nbytes\nend' },
  ]);
  expect(result.matches).toEqual([
    { changeIndex: 1, path: `${presetBlocksPath}/1/text`, normalization: 'crlf-lf' },
    { changeIndex: 2, path: `${presetBlocksPath}/2/text`, normalization: 'crlf-lf' },
  ]);
});

test('whole-model validation does not blame an unrelated last change', () => {
  const { store, preset, target } = presetFixture([{ type: 'plain', text: 'Keep' }]);
  let caught: unknown;
  try {
    call(store, 'resource.patch', {
      ...target,
      expectedRevision: preset.revision,
      changes: [
        { op: 'set', path: '/program/nativeRisuPreset/preset/unsupported', value: true },
        { op: 'set', path: `${presetBlocksPath}/0/text`, value: 'Valid text' },
      ],
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HelperResourcePatchError);
  expect(caught).toMatchObject({
    details: {
      stage: 'validation',
      changeIndex: null,
      path: null,
      op: null,
      reason: 'invalid_change',
    },
  });
  expect(store.product.get<any>('prompt-preset', preset.id)).toEqual(preset);
  expect(store.db.prepare('SELECT * FROM resource_undo WHERE id=?').get(preset.id)).toBeUndefined();
});

test.each([
  ['A\r\nB\nC / A\nB\r\nC', 'A\r\nB\r\nC', 'text_ambiguous', 2],
  ['aaaa', 'aa', 'text_ambiguous', 3],
  ['A\r\nB', 'A\nC', 'text_not_found', 0],
] as const)(
  'failed text match reports its change and count without saving: %s',
  (body, oldText, reason, matchCount) => {
    const { store, preset, target } = presetFixture([{ type: 'plain', text: body }]);
    let caught: unknown;
    try {
      call(store, 'resource.patch', {
        ...target,
        expectedRevision: preset.revision,
        changes: [
          { op: 'set', path: '/title', value: 'Must roll back' },
          { op: 'replaceText', path: `${presetBlocksPath}/0/text`, oldText, newText: 'Wrong' },
        ],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HelperResourcePatchError);
    expect(caught).toMatchObject({
      statusCode: 409,
      details: {
        changeIndex: 1,
        path: `${presetBlocksPath}/0/text`,
        op: 'replaceText',
        reason,
        matchCount,
      },
    });
    expect(store.product.get<any>('prompt-preset', preset.id)).toEqual(preset);
    expect(
      store.db.prepare('SELECT * FROM resource_undo WHERE id=?').get(preset.id)
    ).toBeUndefined();
  }
);

test.each([
  ['', {}, { removedKeys: ['tone'], resetKeys: [] }],
  ['mood=Mood=text', { mood: '' }, { removedKeys: ['tone'], resetKeys: [] }],
  ['tone=Tone=select=Quiet,Loud', { tone: '0' }, { removedKeys: [], resetKeys: ['tone'] }],
  ['tone=Renamed label=text\nmode=Mode', { tone: 'warm', mode: '0' }, undefined],
] as const)(
  'toggle changes reconcile only inherited values: %s',
  (declaration, values, metadata) => {
    const { store, preset, target } = presetFixture([{ type: 'plain', text: 'Keep' }]);
    const result = call(store, 'resource.patch', {
      ...target,
      expectedRevision: preset.revision,
      changes: [
        {
          op: 'set',
          path: '/program/nativeRisuPreset/preset/customPromptTemplateToggle',
          value: declaration,
        },
      ],
    });
    const saved = store.product.get<any>('prompt-preset', preset.id);
    expect(saved.values).toEqual(values);
    expect(saved.program.nativeRisuPreset.preset.promptTemplate).toEqual(
      preset.program.nativeRisuPreset.preset.promptTemplate
    );
    expect(result.reconciledValues).toEqual(metadata);
    expect(saved.revision).toBe(preset.revision + 1);
    call(store, 'resource.undo', { ...target, expectedRevision: saved.revision });
    expect(store.product.get<any>('prompt-preset', preset.id)).toEqual({
      ...preset,
      revision: preset.revision + 2,
    });
  }
);

test.each(['', 'tone=Tone=select=Quiet,Loud'])(
  'explicit invalid values cannot be silently removed or reset: %s',
  (declaration) => {
    const { store, preset, target } = presetFixture([{ type: 'plain', text: 'Keep' }]);
    let caught: unknown;
    try {
      call(store, 'resource.patch', {
        ...target,
        expectedRevision: preset.revision,
        changes: [
          { op: 'set', path: '/values/tone', value: 'warm' },
          {
            op: 'set',
            path: '/program/nativeRisuPreset/preset/customPromptTemplateToggle',
            value: declaration,
          },
        ],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      details: { changeIndex: 0, path: '/values/tone', op: 'set', reason: 'invalid_value' },
    });
    expect(store.product.get<any>('prompt-preset', preset.id)).toEqual(preset);
    expect(
      store.db.prepare('SELECT * FROM resource_undo WHERE id=?').get(preset.id)
    ).toBeUndefined();
  }
);

test('new explicit values use final declarations and reverting a declaration remains a no-op', () => {
  const { store, preset, target } = presetFixture([{ type: 'plain', text: 'Keep' }]);
  const path = '/program/nativeRisuPreset/preset/customPromptTemplateToggle';
  expect(
    call(store, 'resource.patch', {
      ...target,
      expectedRevision: preset.revision,
      changes: [
        { op: 'set', path, value: '' },
        { op: 'set', path, value: 'tone=Tone=text' },
      ],
    })
  ).toEqual({ id: preset.id, revision: preset.revision, changedPaths: [] });
  const result = call(store, 'resource.patch', {
    ...target,
    expectedRevision: preset.revision,
    changes: [
      { op: 'set', path: '/values/mood', value: '1' },
      { op: 'set', path, value: 'mood=Mood=select=Quiet,Loud' },
    ],
  });
  expect(store.product.get<any>('prompt-preset', preset.id).values).toEqual({ mood: '1' });
  expect(result.reconciledValues).toEqual({ removedKeys: ['tone'], resetKeys: [] });
});

test('previous reads expose the current undo slot without changing saved state or advertising patch targets', () => {
  const { store, preset, target } = presetFixture([{ type: 'plain', text: 'First' }]);
  expect(() => call(store, 'resource.read', { ...target, version: 'previous' })).toThrow(
    '직전 저장본이 없어요'
  );
  const path = `${presetBlocksPath}/0/text`;
  const second = call(store, 'resource.patch', {
    ...target,
    expectedRevision: preset.revision,
    changes: [{ op: 'set', path, value: 'Second' }],
  });
  const saved = store.product.get<any>('prompt-preset', preset.id);
  const undo = store.db.prepare('SELECT * FROM resource_undo WHERE id=?').get(preset.id);
  const previous = call(store, 'resource.read', { ...target, version: 'previous', path });
  expect(previous).toMatchObject({
    version: 'previous',
    revision: null,
    currentRevision: second.revision,
    text: 'First',
  });
  const outline = call(store, 'resource.read', {
    ...target,
    version: 'previous',
    path: presetBlocksPath,
  });
  expect(outline.items[0]).not.toHaveProperty('target');
  expect(store.product.get<any>('prompt-preset', preset.id)).toEqual(saved);
  expect(store.db.prepare('SELECT * FROM resource_undo WHERE id=?').get(preset.id)).toEqual(undo);
  const third = call(store, 'resource.patch', {
    ...target,
    expectedRevision: second.revision,
    changes: [{ op: 'set', path, value: 'Third' }],
  });
  expect(
    call(store, 'resource.read', { ...target, version: 'previous', paths: [path] }).items[0]
  ).toMatchObject({
    version: 'previous',
    currentRevision: third.revision,
    revision: null,
    text: 'Second',
  });
  store.db
    .prepare('UPDATE resource_undo SET saved_revision=? WHERE id=?')
    .run(second.revision, preset.id);
  expect(() => call(store, 'resource.read', { ...target, version: 'previous', path })).toThrow(
    '최근 저장 이후'
  );
  store.db
    .prepare('UPDATE resource_undo SET saved_revision=?,model=? WHERE id=?')
    .run(third.revision, '{broken', preset.id);
  expect(() => call(store, 'resource.read', { ...target, version: 'previous', path })).toThrow(
    '직전 저장본을 읽을 수 없어요'
  );
  expect(call(store, 'resource.read', { ...target, path }).text).toBe('Third');
});
