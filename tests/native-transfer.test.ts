import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import {
  applyNativeTransfer,
  exportNativeTransfer,
  nativeTransferOriginal,
  nativeTransferRoutes,
  prepareNativeTransfer,
} from '../server/native-transfer.js';
import { validateNativeTransfer } from '../core/native-transfer-validation.js';
import { NATIVE_TRANSFER_MAX_BYTES, type NativeTransferFile } from '../core/native-transfer.js';
import type {
  Content,
  ModelPreset,
  PromptPreset,
  SavedPromptCombination,
} from '../core/product.js';
import type { ContentPackage } from '../core/content-package.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { createAgentCollaboration, createAgentDefinition } from '../core/agent-collaboration.js';
import { promptWorkspace } from '../server/prompt-workspace.js';
import { resolvePackageModules } from '../server/package-features.js';
import { putImageBlob } from '../server/package-images.js';
import { createActionPackage } from './fixtures/action-package.js';

const owned: { directory: string; store: Store; app: FastifyInstance }[] = [];
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('No external calls in native transfer tests')
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0).reverse()) {
    await item.app.close();
    item.store.close();
    const path = resolve(item.directory),
      within = relative(resolve(tmpdir()), path);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-native-transfer-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-native-transfer-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  const app = Fastify();
  nativeTransferRoutes(app, store);
  owned.push({ directory, store, app });
  return { store, app };
}
function save(
  store: Store,
  kind: Content['kind'],
  title: string,
  part: Partial<ContentPackage> = {},
  previous?: Content
): Content {
  const pkg = {
    ...createActionPackage(),
    title,
    description: '',
    body: `SYNTHETIC_BODY_${kind}: opaque original IDs stay unchanged`,
    modules: [],
    ...part,
  };
  return store.product.content(
    {
      kind,
      title,
      description: '',
      text: pkg.body,
      loading: 'pinned',
      relatedIds: [],
      package: pkg,
      ...(previous ? { expectedRevision: previous.revision } : {}),
    },
    previous?.id
  ) as Content;
}
function model(store: Store): ModelPreset {
  const connection = store.product.connection({
    title: 'Synthetic private connection',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:49999/turn',
    credentialEnv: 'NATIVE_TRANSFER_PRIVATE_CREDENTIAL',
    enabled: true,
  });
  return store.product.model({
    title: 'Synthetic private model',
    connectionId: connection.id,
    modelId: 'synthetic-model',
    maxOutputTokens: 1024,
    temperature: null,
  }) as ModelPreset;
}
function sourceFixture() {
  const { store, app } = database();
  const image = putImageBlob(store.product, {
    mime: 'image/png',
    base64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=',
  });
  const shared = save(store, 'module', 'Same name', {
    images: [
      {
        id: 'synthetic',
        title: 'Synthetic pixel',
        description: '',
        blobHash: image.hash,
        mime: image.mime,
        allowedUse: 'both',
      },
    ],
    portraitImageId: 'synthetic',
  });
  const middle = save(store, 'module', 'Same name', { modules: [{ id: shared.id, revision: 1 }] });
  const bot = save(store, 'bot', 'Same name', {
    modules: [
      { id: middle.id, revision: 1 },
      { id: shared.id, revision: 1 },
    ],
  });
  const persona = save(store, 'persona', 'Same name', {
    modules: [{ id: shared.id, revision: 1 }],
  });
  const newer = save(
    store,
    'module',
    'Same name',
    { ...shared.package, body: 'SYNTHETIC_LATEST_SHARED_BODY' },
    shared
  );
  const program = {
    ...createDefaultPromptProgram('SYNTHETIC_PROMPT_BODY', 'main'),
    controls: [{ id: 'tone', label: 'Tone', type: 'text' as const, default: 'calm' }],
    collaboration: {
      ...createAgentCollaboration(),
      enabled: true,
      agents: [{ ...createAgentDefinition('custom', 'reviewer'), model: { id: model(store).id } }],
    },
  };
  const prompt = store.product.promptPreset({
    title: 'Same name',
    role: 'main',
    program,
    values: { tone: 'warm' },
  }) as PromptPreset;
  store.product.promptCombination({
    title: 'Current options',
    role: 'main',
    values: { tone: 'bold' },
    owner: { kind: 'preset', id: prompt.id },
    expectedRevision: 1,
  });
  store.product.save('prompt-combination', {
    title: 'Previous options',
    role: 'main',
    values: { old: true },
    owner: { kind: 'preset', id: prompt.id },
    controls: [{ id: 'old', label: 'Old', type: 'boolean', default: false }],
  });
  const file = exportNativeTransfer(store, {
    items: [
      { kind: 'content', id: bot.id },
      { kind: 'content', id: persona.id },
      { kind: 'prompt-preset', id: prompt.id },
    ],
  });
  return { store, app, file, bot, persona, middle, shared: newer, prompt };
}
function request(file: NativeTransferFile, key = 'synthetic-import') {
  const prepared = prepareNativeTransfer({ file });
  return {
    file,
    digest: prepared.digest,
    modelBindings: prepared.modelRequirements.map((item) => ({
      requirementKey: item.key,
      mode: 'inherit-main' as const,
    })),
    idempotencyKey: key,
  };
}
function snapshot(store: Store) {
  return store.product.export().tables;
}

test('NATIVE14 opaque source files retain their bytes and entry ownership through re-export and archive', () => {
  const f = sourceFixture(),
    target = database().store;
  const entry = f.file.contents.find((item) => item.source.id === f.persona.id)!;
  const bytes = Buffer.from([0, 255, 13, 10, 83, 89, 78, 84, 72]);
  const attached = {
    entryKey: entry.key,
    name: 'synthetic-original.bin',
    mediaType: 'application/octet-stream',
    hash: createHash('sha256').update(bytes).digest('hex'),
    base64: bytes.toString('base64'),
  };
  f.file.sourceFiles = [attached];
  const prepared = prepareNativeTransfer({ file: f.file });
  expect(prepared.summary).toMatchObject({ sourceFiles: 1, sourceFileBytes: bytes.length });
  const receipt = applyNativeTransfer(target, request(f.file));
  const imported = receipt.items.find((item) => item.key === entry.key)!;
  expect(nativeTransferOriginal(target, receipt.id)).toEqual(f.file);
  expect(JSON.stringify(target.product.all('content'))).not.toContain(attached.base64);
  const exported = exportNativeTransfer(target, { items: [{ kind: 'content', id: imported.id }] });
  expect(exported.sourceFiles).toEqual([{ ...attached, entryKey: exported.roots[0].key }]);
  const restored = database().store;
  restored.product.import(target.product.export());
  expect(nativeTransferOriginal(restored, receipt.id)).toEqual(f.file);
  expect(exportNativeTransfer(restored, { items: [{ kind: 'content', id: imported.id }] })).toEqual(
    exported
  );
  expect(applyNativeTransfer(restored, request(f.file))).toMatchObject({
    id: receipt.id,
    created: false,
  });
});

test('NATIVE15 invalid source bytes, attachment keys and forged archive files are rejected before writes', () => {
  const f = sourceFixture(),
    target = database().store;
  const bytes = Buffer.from('SYNTHETIC ORIGINAL');
  const attached = {
    entryKey: f.file.contents[0].key,
    name: 'source.txt',
    mediaType: 'text/plain',
    hash: createHash('sha256').update(bytes).digest('hex'),
    base64: bytes.toString('base64'),
  };
  f.file.sourceFiles = [attached];
  const before = snapshot(target);
  for (const change of [
    { hash: '0'.repeat(64) },
    { base64: attached.base64 + '\n' },
    { entryKey: 'not-in-file' },
    { name: '../source.txt' },
  ]) {
    const file = { ...f.file, sourceFiles: [{ ...attached, ...change }] };
    expect(() => prepareNativeTransfer({ file })).toThrow();
  }
  expect(snapshot(target)).toEqual(before);
  const receipt = applyNativeTransfer(target, request(f.file));
  const archive = target.product.export();
  const row = archive.tables.native_transfer_receipts[0] as any;
  const original = JSON.parse(row.original);
  original.sourceFiles[0].base64 = Buffer.from('altered').toString('base64');
  row.original = JSON.stringify(original);
  const restored = database().store,
    empty = snapshot(restored);
  expect(() => restored.product.import(archive)).toThrow('NATIVE_TRANSFER_SOURCE_FILE_HASH');
  expect(snapshot(restored)).toEqual(empty);
  expect(nativeTransferOriginal(target, receipt.id)).toEqual(f.file);
});

test('NATIVE16 source bytes share the existing whole-file size limit', () => {
  const { file } = sourceFixture();
  file.sourceFiles = [
    {
      entryKey: file.contents[0].key,
      name: 'large.bin',
      mediaType: 'application/octet-stream',
      hash: '0'.repeat(64),
      base64: 'A'.repeat(NATIVE_TRANSFER_MAX_BYTES),
    },
  ];
  expect(() => prepareNativeTransfer({ file })).toThrow('NATIVE_TRANSFER_TOO_LARGE');
});

test('NATIVE01 captures nested shared modules at their effective revision and preserves authored source refs', () => {
  const f = sourceFixture();
  const prepared = prepareNativeTransfer({ file: f.file });
  expect(prepared.summary).toMatchObject({ contents: 4, prompts: 1, combinations: 2, images: 1 });
  expect(prepared.modelRequirements).toMatchObject([
    { agentId: 'reviewer', promptTitle: 'Same name' },
  ]);
  expect(prepared.warnings).toMatchObject([{ code: 'COMBINATION_INACTIVE' }]);
  const bot = f.file.contents.find((entry) => entry.source.id === f.bot.id)!;
  const shared = f.file.contents.find((entry) => entry.source.id === f.shared.id)!;
  expect(bot.source.package!.modules![1].revision).toBe(1);
  expect(shared.source.revision).toBe(2);
  expect(bot.modules[1]).toBe(shared.key);
  expect(f.store.product.get<Content>('content', f.bot.id).package!.modules![1].revision).toBe(1);
  expect(JSON.stringify(f.file)).not.toContain('NATIVE_TRANSFER_PRIVATE_CREDENTIAL');
  expect(JSON.stringify(f.file)).not.toContain('http://127.0.0.1:49999');
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test('NATIVE02 prepare writes nothing; apply creates one identity graph without changing global selections', async () => {
  const source = sourceFixture(),
    target = database();
  const before = snapshot(target.store),
    workspace = promptWorkspace(target.store);
  const prepared = await target.app.inject({
    method: 'POST',
    url: '/api/native-transfers/prepare',
    payload: { file: source.file },
  });
  expect(prepared.statusCode).toBe(200);
  expect(snapshot(target.store)).toEqual(before);
  const response = await target.app.inject({
    method: 'POST',
    url: '/api/native-transfers/apply',
    payload: request(source.file),
  });
  expect(response.statusCode, response.body).toBe(200);
  const receipt = response.json();
  expect(receipt.items).toHaveLength(5);
  expect(new Set(receipt.items.map((item: any) => item.id)).size).toBe(5);
  expect(receipt.items.every((item: any) => item.revision === 1)).toBe(true);
  expect(promptWorkspace(target.store)).toEqual(workspace);
  expect(target.store.chats()).toEqual([]);
  expect(target.store.db.prepare('SELECT count(*) n FROM package_behavior_states').get()).toEqual({
    n: 0,
  });
  expect(target.store.db.prepare('SELECT count(*) n FROM attempts').get()).toEqual({ n: 0 });
  const importedBot = receipt.items.find((item: any) => item.category === 'bot');
  const importedPersona = receipt.items.find((item: any) => item.category === 'persona');
  const graph = resolvePackageModules(target.store.product, [
    { id: importedBot.id, revision: 1, role: 'bot' },
    { id: importedPersona.id, revision: 1, role: 'persona' },
  ]);
  expect(graph.attachments.map((ref) => ref.role)).toEqual(['bot', 'module', 'module', 'persona']);
  const bot = target.store.product.get<Content>('content', importedBot.id);
  expect(bot.package!.modules![1].id).toBe(graph.attachments[2].id);
  const importedPrompt = receipt.items.find((item: any) => item.kind === 'prompt-preset');
  const prompt = target.store.product.get<PromptPreset>('prompt-preset', importedPrompt.id);
  expect(prompt.program.collaboration!.agents[0].model).toBeNull();
  expect(prompt.values).toEqual({ tone: 'warm' });
  const combinations = target.store.product.all('prompt-combination') as SavedPromptCombination[];
  expect(combinations).toHaveLength(2);
  expect(
    combinations.every(
      (item) => item.owner?.kind === 'preset' && item.owner.id === importedPrompt.id
    )
  ).toBe(true);
  expect(combinations.find((item) => item.title === 'Previous options')!.controls).toEqual(
    source.file.prompts[0].combinations.find((item) => item.title === 'Previous options')!.controls
  );
  expect(nativeTransferOriginal(target.store, receipt.id)).toEqual(source.file);
  const original = String(
    target.store.db.prepare('SELECT original FROM native_transfer_receipts').get()!.original
  );
  expect(original).not.toContain('SYNTHETIC_BODY');
  expect(original).not.toContain('SYNTHETIC_PROMPT_BODY');
  expect(original).not.toContain(source.file.images[0].base64);
  expect(target.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test('NATIVE03 same installation IDs and duplicate names are copied; durable keys prevent duplicates across reopen', () => {
  const f = sourceFixture(),
    before = snapshot(f.store);
  const first = applyNativeTransfer(f.store, request(f.file));
  expect(
    first.items.some((item) => f.file.contents.some((source) => source.source.id === item.id))
  ).toBe(false);
  expect(f.store.product.get('content', f.bot.id)).toEqual(
    f.file.contents.find((item) => item.source.id === f.bot.id)!.source
  );
  const applied = snapshot(f.store);
  const owner = owned.find((item) => item.store === f.store)!;
  f.store.close();
  owner.store = new Store(join(owner.directory, 'synthetic.sqlite'));
  expect(applyNativeTransfer(owner.store, request(f.file))).toEqual({ ...first, created: false });
  expect(snapshot(owner.store)).toEqual(applied);
  const second = applyNativeTransfer(owner.store, request(f.file, 'another-import'));
  expect(second.items.every((item) => !first.items.some((prior) => prior.id === item.id))).toBe(
    true
  );
  expect((snapshot(owner.store).versions as any[]).length).toBeGreaterThan(
    (before.versions as any[]).length
  );
});

test('NATIVE04 mapping is explicit and revalidated; unavailable local model and reused-key changes write nothing', () => {
  const source = sourceFixture(),
    { store } = database();
  const body = request(source.file),
    before = snapshot(store);
  expect(() => applyNativeTransfer(store, { ...body, modelBindings: [] })).toThrow(
    'MODEL_BINDINGS_REQUIRED'
  );
  expect(() =>
    applyNativeTransfer(store, {
      ...body,
      modelBindings: [
        {
          requirementKey: body.modelBindings[0].requirementKey,
          mode: 'local',
          model: { id: 'missing-model' },
        },
      ],
    })
  ).toThrow();
  expect(snapshot(store)).toEqual(before);
  const local = model(store);
  const mapping = [
    {
      requirementKey: body.modelBindings[0].requirementKey,
      mode: 'local' as const,
      model: { id: local.id },
    },
  ];
  const receipt = applyNativeTransfer(store, { ...body, modelBindings: mapping });
  expect(
    store.product.get<PromptPreset>(
      'prompt-preset',
      receipt.items.find((item) => item.kind === 'prompt-preset')!.id
    ).program.collaboration!.agents[0].model
  ).toEqual({ id: local.id });
  const after = snapshot(store);
  expect(() => applyNativeTransfer(store, body)).toThrow('IMPORT_CONFLICT');
  expect(() =>
    applyNativeTransfer(store, { ...body, digest: '0'.repeat(64), idempotencyKey: 'new-key' })
  ).toThrow('DRAFT_CHANGED');
  expect(snapshot(store)).toEqual(after);
  store.db.prepare("INSERT INTO library_hidden VALUES('model',?)").run(local.id);
  const hidden = snapshot(store);
  expect(() =>
    applyNativeTransfer(store, {
      ...body,
      modelBindings: mapping,
      idempotencyKey: 'changed-local-model',
    })
  ).toThrow();
  expect(snapshot(store)).toEqual(hidden);
});

test('NATIVE05 a failure after creating dependencies rolls the whole apply back including images and organization', () => {
  const source = sourceFixture(),
    { store } = database(),
    before = snapshot(store);
  vi.spyOn(store.product, 'promptPreset').mockImplementation(() => {
    throw Object.assign(new Error('Synthetic disk failure'), { code: 'SQLITE_FULL' });
  });
  expect(() => applyNativeTransfer(store, request(source.file))).toThrow('Synthetic disk failure');
  expect(snapshot(store)).toEqual(before);
});

test.each([
  'cycle',
  'missing-module',
  'wrong-module-id',
  'extra-entry',
  'foreign-combination',
  'unknown-field',
  'image-hash',
  'unused-image',
] as const)('NATIVE06 invalid graphs and metadata reject before any write: %s', (variant) => {
  const source = sourceFixture(),
    { store } = database(),
    file = structuredClone(source.file),
    before = snapshot(store);
  const root = file.contents.find((item) => item.source.kind === 'bot')!;
  if (variant === 'cycle') {
    root.source.package!.modules = [{ id: root.source.id, revision: 1 }];
    root.modules = [root.key];
  } else if (variant === 'missing-module') root.modules[0] = 'missing';
  else if (variant === 'wrong-module-id') root.source.package!.modules![0].id = 'unrelated';
  else if (variant === 'extra-entry')
    file.contents.push({
      ...structuredClone(root),
      key: 'extra',
      source: {
        ...root.source,
        id: 'another-id',
        package: { ...root.source.package!, id: 'another-id' },
      },
    });
  else if (variant === 'foreign-combination')
    file.prompts[0].combinations[0].owner = { kind: 'preset', id: 'foreign' };
  else if (variant === 'unknown-field')
    Object.assign(root.source, { credential: 'not-a-native-field' });
  else if (variant === 'image-hash')
    file.images[0].base64 = Buffer.from('not an image').toString('base64');
  else file.images.push(structuredClone(file.images[0]));
  expect(() => prepareNativeTransfer({ file })).toThrow();
  expect(snapshot(store)).toEqual(before);
});

test('NATIVE07 external related IDs are reported and preserved as origin while bundled links and opaque text are kept', () => {
  const f = sourceFixture(),
    { store } = database(),
    file = structuredClone(f.file);
  const root = file.contents.find((entry) => entry.source.kind === 'bot')!;
  root.source.relatedIds = [f.persona.id, 'external-reference'];
  root.source.text += ` ${f.persona.id} external-reference`;
  root.source.package!.body = root.source.text;
  const prepared = prepareNativeTransfer({ file });
  expect(prepared.warnings).toContainEqual(
    expect.objectContaining({ code: 'EXTERNAL_RELATED_IDS', key: root.key })
  );
  const receipt = applyNativeTransfer(store, request(file));
  const imported = store.product.get<Content>(
    'content',
    receipt.items.find((item) => item.key === root.key)!.id
  );
  expect(imported.text).toBe(root.source.text);
  expect(imported.relatedIds).toEqual([
    receipt.items.find((item) => item.category === 'persona')!.id,
  ]);
  expect(nativeTransferOriginal(store, receipt.id)).toEqual(file);
});

test('NATIVE08 origin survives hidden entries, later edits, re-export and archive restore without embedding bodies in receipts', () => {
  const source = sourceFixture(),
    { store } = database();
  const receipt = applyNativeTransfer(store, request(source.file));
  const bot = receipt.items.find((item) => item.category === 'bot')!;
  const saved = store.product.get<Content>('content', bot.id);
  save(
    store,
    'bot',
    'Edited imported bot',
    { ...saved.package!, body: 'Later edited text' },
    saved
  );
  const exported = exportNativeTransfer(store, { items: [{ kind: 'content', id: bot.id }] });
  expect(exported.contents.find((item) => item.source.id === bot.id)!.origin).toMatchObject({
    digest: receipt.digest,
    sourceId: source.bot.id,
  });
  store.db.prepare("INSERT INTO library_hidden VALUES('content',?)").run(bot.id);
  expect(() => exportNativeTransfer(store, { items: [{ kind: 'content', id: bot.id }] })).toThrow(
    'deleted'
  );
  expect(nativeTransferOriginal(store, receipt.id)).toEqual(source.file);
  const target = database().store;
  target.product.import(store.product.export());
  expect(nativeTransferOriginal(target, receipt.id)).toEqual(source.file);
  expect(applyNativeTransfer(target, request(source.file))).toEqual({ ...receipt, created: false });
});

test.each([
  'origin-target',
  'source-identity',
  'receipt-target',
  'combination-target',
  'mapped-model',
] as const)('NATIVE09 archive rejects crossed origin bindings atomically: %s', (variant) => {
  const source = sourceFixture(),
    { store } = database();
  const receipt = applyNativeTransfer(store, request(source.file));
  const archive = store.product.export();
  const row = archive.tables.native_transfer_receipts[0] as any;
  const index = JSON.parse(row.original),
    body = JSON.parse(row.body);
  if (variant === 'origin-target') index.contents[0].id = index.contents[1].id;
  else if (variant === 'source-identity') index.contents[0].source.id = 'foreign-source';
  else if (variant === 'receipt-target') body.items[0].id = body.items[1].id;
  else if (variant === 'combination-target')
    index.prompts[0].combinations[0].id = index.contents[0].id;
  else {
    const promptId = receipt.items.find((item) => item.kind === 'prompt-preset')!.id;
    const promptRow = archive.tables.versions.find((item: any) => item.id === promptId) as any;
    const prompt = JSON.parse(promptRow.body);
    prompt.program.collaboration.enabled = false;
    promptRow.body = JSON.stringify(prompt);
  }
  row.original = JSON.stringify(index);
  row.body = JSON.stringify(body);
  const target = database().store,
    before = snapshot(target);
  expect(() => target.product.import(archive)).toThrow();
  expect(snapshot(target)).toEqual(before);
});

test('NATIVE10 prepare and core validation detach their output without editing the original file', () => {
  const source = sourceFixture(),
    before = structuredClone(source.file);
  const checked = validateNativeTransfer(source.file);
  checked.file.contents[0].source.title = 'Changed detached output';
  expect(source.file).toEqual(before);
  expect(prepareNativeTransfer({ file: source.file })).not.toHaveProperty('file');
});

test('NATIVE11 two receipts cannot claim creation of the same non-image identities', () => {
  const source = sourceFixture(),
    { store } = database();
  applyNativeTransfer(store, request(source.file));
  const archive = store.product.export(),
    original = archive.tables.native_transfer_receipts[0] as any;
  const duplicate = {
    ...original,
    id: 'synthetic-second-receipt',
    request_key: 'other-key',
    created_at: '2026-09-12T00:00:00.000Z',
  };
  duplicate.body = JSON.stringify({
    ...JSON.parse(original.body),
    id: duplicate.id,
    importedAt: duplicate.created_at,
  });
  archive.tables.native_transfer_receipts.push(duplicate);
  const target = database().store,
    before = snapshot(target);
  expect(() => target.product.import(archive)).toThrow('NATIVE_TRANSFER_REUSED_IDENTITY');
  expect(snapshot(target)).toEqual(before);
});

test('NATIVE12 the native file uses the existing module depth limit before persistence', () => {
  const file: NativeTransferFile = {
    format: 'uimori-native-transfer',
    version: 1,
    roots: [{ kind: 'content', key: 'node-0' }],
    prompts: [],
    images: [],
    contents: Array.from({ length: 22 }, (_, index) => {
      const key = `node-${index}`,
        modules = index < 21 ? [`node-${index + 1}`] : [];
      return {
        key,
        modules,
        source: {
          id: key,
          revision: 1,
          kind: 'module',
          title: key,
          description: '',
          text: 'Synthetic depth',
          loading: 'pinned',
          relatedIds: [],
          package: {
            version: 1,
            id: key,
            revision: 1,
            title: key,
            description: '',
            body: 'Synthetic depth',
            modules: modules.map((id) => ({ id, revision: 1 })),
            lore: [],
            controls: [],
            instructions: [],
            transforms: [],
          },
        },
      };
    }),
  };
  expect(() => prepareNativeTransfer({ file })).toThrow('Package module dependency limit');
});

test('NATIVE13 export enforces SQLite byte lengths before loading an oversized dependency body', () => {
  const f = sourceFixture(),
    before = snapshot(f.store);
  const read = vi.spyOn(f.store.product, 'get');
  const prepare = f.store.db.prepare.bind(f.store.db);
  vi.spyOn(f.store.db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql);
    if (!sql.startsWith('SELECT length(CAST(body AS BLOB))')) return statement;
    return {
      get: (...args: any[]) =>
        args[1] === f.shared.id ? { bytes: NATIVE_TRANSFER_MAX_BYTES + 1 } : statement.get(...args),
    } as ReturnType<typeof prepare>;
  });
  expect(() =>
    exportNativeTransfer(f.store, { items: [{ kind: 'content', id: f.bot.id }] })
  ).toThrow('NATIVE_TRANSFER_TOO_LARGE');
  expect(read.mock.calls.some((args) => args[1] === f.shared.id)).toBe(false);
  expect(snapshot(f.store)).toEqual(before);
});
