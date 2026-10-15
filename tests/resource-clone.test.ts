import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, expect, test } from 'vitest';
import type { Content, PromptPreset } from '../core/product.js';
import { editableResource } from '../core/resource-editing.js';
import { deleteLibraryItem } from '../server/library-deletion.js';
import { putImageBlob } from '../server/package-images.js';
import { promptWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';
import { resourceRoutes } from '../server/resource-routes.js';
import { cloneResource, saveResource } from '../server/resource-service.js';
import { Store } from '../server/store.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { nativeContent } from './fixtures/native-content.js';
import { nativePrompt } from './fixtures/native-prompt.js';

const owned: { path: string; store: Store; app: FastifyInstance }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    await item.app.close();
    item.store.close();
    const within = relative(tmpdir(), item.path);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(item.path).startsWith('uimori-resource-clone-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(item.path, { recursive: true, force: true });
  }
});
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-resource-clone-'));
  const store = new Store(join(path, 'test.sqlite'));
  const app = Fastify();
  resourceRoutes(app, store);
  owned.push({ path, store, app });
  return { store, app };
}
const postClone = (app: FastifyInstance, payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/resources/clone', payload: payload as object });
const rows = (store: Store) => store.db.prepare('SELECT * FROM versions ORDER BY kind,id').all();

test('cloning a saved preset preserves all authored fields and current values, without combinations, selection or undo', async () => {
  const { store, app } = fixture();
  const initial = store.product.promptPreset({
    title: 'Version 1',
    role: 'main',
    program: nativePrompt('Keep {{getglobalvar::toggle_tone}}.', {
      name: 'Independent native name',
      customPromptTemplateToggle: 'tone=Tone=text\nmode=Mode=select=Story,Notes',
      templateDefaultVariables: 'tone=quiet\nmode=0',
      promptTemplate: [
        { id: 'core', name: 'Core', type: 'plain', role: 'system', text: 'Authored core' },
        { id: 'history', type: 'chat', rangeStart: 0, rangeEnd: 'end' },
        { id: 'cache', type: 'cache', depth: 0 },
        { id: 'tail', type: 'plain', role: 'user', text: '{{slot}}' },
      ],
      promptSettings: { assistantPrefill: 'Preserved prefill', sendName: true },
      regex: [{ type: 'editprocess', in: 'before', out: 'after' }],
    }),
    values: { tone: 'warm', mode: '1' },
  }) as PromptPreset;
  const source = saveResource(store, {
    kind: 'prompt-preset',
    id: initial.id,
    expectedRevision: initial.revision,
    model: { ...editableResource('prompt-preset', initial), title: 'Saved version 2' },
  }).saved as PromptPreset;
  const combination = store.product.promptCombination({
    title: 'Other saved options',
    role: source.role,
    values: { tone: 'bold', mode: '0' },
    owner: { kind: 'preset', id: source.id },
    expectedRevision: source.revision,
  });
  const selected = updatePromptWorkspace(
    store,
    {
      expectedRevision: promptWorkspace(store).revision,
      main: { title: source.title, program: source.program, values: source.values },
    },
    { role: 'main', id: source.id }
  );
  const undoBefore = store.db.prepare('SELECT * FROM resource_undo').all();
  const response = await postClone(app, {
    kind: 'prompt-preset',
    sourceId: source.id,
    expectedSourceRevision: source.revision,
    title: 'Version 3 copy',
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json();
  expect(result).toMatchObject({
    created: true,
    source: { id: source.id, revision: source.revision },
    saved: { title: 'Version 3 copy', revision: 1, role: source.role },
  });
  expect(result.saved.id).not.toBe(source.id);
  expect(result.saved.program).toEqual(source.program);
  expect(result.saved.values).toEqual({ tone: 'warm', mode: '1' });
  expect(store.product.get('prompt-preset', source.id)).toEqual(source);
  expect(store.product.get('prompt-preset', result.saved.id)).toEqual(result.saved);
  expect(promptWorkspace(store)).toEqual(selected);
  expect(store.product.get('prompt-combination', combination.id)).toEqual(combination);
  expect(
    store.db.prepare("SELECT COUNT(*) AS n FROM versions WHERE kind='prompt-combination'").get()!.n
  ).toBe(1);
  expect(store.db.prepare('SELECT * FROM resource_undo').all()).toEqual(undoBefore);

  result.saved.program.nativeRisuPreset.preset.promptTemplate[0].text = 'Caller changed result';
  expect(store.product.get<PromptPreset>('prompt-preset', source.id).program).toEqual(
    source.program
  );
  expect(store.product.get<PromptPreset>('prompt-preset', result.saved.id).program).toEqual(
    source.program
  );
});

test.each(['card', 'module'] as const)(
  'cloning native %s keeps authored data and image/module references with independent identity and name',
  (format) => {
    const { store } = fixture();
    const referenced = store.product.content({
      ...fixtureBotInput('Linked module'),
      kind: 'module',
    }) as Content;
    const image = putImageBlob(store.product, {
      mime: 'image/png',
      base64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNIK1/1HwAFVQKH+f6iOwAAAABJRU5ErkJggg==',
    });
    const pkg = nativeContent(
      {
        name: 'Original',
        description: 'Unchanged body',
        extensions: { custom: 'Opaque metadata' },
      },
      {
        modules: [{ id: referenced.id, revision: referenced.revision }],
        images: [
          {
            id: 'portrait',
            title: 'Pixel',
            description: '',
            blobHash: image.hash,
            mime: image.mime,
            allowedUse: 'both',
          },
        ],
        portraitImageId: 'portrait',
      }
    );
    if (format === 'module') {
      pkg.nativeRisu.card = {};
      pkg.nativeRisu.module = {
        name: 'Original',
        description: 'Unchanged module body',
        lorebook: [],
        regex: [],
        custom: 'Opaque module metadata',
      };
    }
    const source = store.product.content({
      kind: format === 'module' ? 'module' : 'bot',
      title: pkg.title,
      description: pkg.description,
      text: pkg.body,
      loading: 'discoverable',
      relatedIds: [referenced.id],
      package: pkg,
    }) as Content;
    const chatsBefore = store.chats();
    const copy = cloneResource(store, {
      kind: 'content',
      sourceId: source.id,
      expectedSourceRevision: source.revision,
      title: 'New copy',
    }).saved as Content;
    expect(copy.id).not.toBe(source.id);
    expect(copy.revision).toBe(1);
    expect(copy.kind).toBe(source.kind);
    expect(copy.title).toBe('New copy');
    expect(copy.relatedIds).toEqual([]);
    expect(copy.description).toBe(source.description);
    expect(copy.text).toBe(source.text);
    expect(copy.loading).toBe('discoverable');
    expect(copy.package.id).toBe(copy.id);
    expect(copy.package.revision).toBe(1);
    expect(copy.package.images).toEqual(source.package.images);
    expect(copy.package.modules).toEqual(source.package.modules);
    expect(copy.package.portraitImageId).toBe('portrait');
    const expectedNative = structuredClone(source.package.nativeRisu);
    if (format === 'module') expectedNative.module!.name = 'New copy';
    else expectedNative.card.name = 'New copy';
    expect(copy.package.nativeRisu).toEqual(expectedNative);
    expect(store.product.get('content', source.id)).toEqual(source);
    expect(store.product.get('content', referenced.id)).toEqual(referenced);
    expect(store.product.get('content', copy.id)).toEqual(copy);
    expect(store.chats()).toEqual(chatsBefore);
  }
);

test('stale, unavailable and missing sources never create a partial copy', async () => {
  const { store, app } = fixture();
  const source = store.product.promptPreset({
    title: 'Source',
    role: 'main',
    text: 'Saved text',
  }) as PromptPreset;
  const request = {
    kind: 'prompt-preset',
    sourceId: source.id,
    expectedSourceRevision: source.revision,
    title: 'Copy',
  };
  let before = rows(store);
  let organization = store.libraryOrganization.snapshot();
  expect(
    (await postClone(app, { ...request, expectedSourceRevision: source.revision + 1 })).statusCode
  ).toBe(409);
  expect(rows(store)).toEqual(before);
  expect(store.libraryOrganization.snapshot()).toEqual(organization);
  deleteLibraryItem(store, 'prompt-preset', source.id, { expectedRevision: source.revision });
  before = rows(store);
  organization = store.libraryOrganization.snapshot();
  expect((await postClone(app, request)).statusCode).toBe(404);
  expect((await postClone(app, { ...request, sourceId: 'missing-source' })).statusCode).toBe(404);
  expect(rows(store)).toEqual(before);
  expect(store.libraryOrganization.snapshot()).toEqual(organization);
});

test('clone route rejects unsupported kinds, incomplete or extra fields, and invalid revisions before writing', async () => {
  const { store, app } = fixture();
  const source = store.product.promptPreset({
    title: 'Source',
    role: 'main',
    text: 'Text',
  }) as PromptPreset;
  const valid = {
    kind: 'prompt-preset',
    sourceId: source.id,
    expectedSourceRevision: source.revision,
    title: 'Copy',
  };
  const before = rows(store);
  const organization = store.libraryOrganization.snapshot();
  for (const payload of [
    ...['prompt-workspace', 'theme', 'illustration-preset', 'model'].map((kind) => ({
      ...valid,
      kind,
    })),
    { ...valid, id: 'caller-chosen-id' },
    { ...valid, model: {} },
    { ...valid, sourceId: '' },
    { ...valid, title: ' ' },
    { ...valid, title: 'x'.repeat(201) },
    ...[undefined, null, 0, 1.5, '1'].map((expectedSourceRevision) => ({
      ...valid,
      expectedSourceRevision,
    })),
  ]) {
    const response = await postClone(app, payload);
    expect(response.statusCode, response.body).toBe(400);
  }
  expect(rows(store)).toEqual(before);
  expect(store.libraryOrganization.snapshot()).toEqual(organization);
});
