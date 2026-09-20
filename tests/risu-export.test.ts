import { afterEach, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import type { Content, PromptPreset } from '../core/product.js';
import { exportRisuContent, exportRisuPrompt, risuExportRoutes } from '../server/risu-export.js';
import { exportJson, writeEmbeddedRisuModule, writeRisuZip } from '../server/risu-export-codec.js';
import { analyzeNativeRisuImport } from '../server/risu-native-import.js';
import { cardZip, readCharacterCard } from '../server/character-card-file.js';
import { readRisuPresetFile } from '../server/risu-preset-file.js';
import { prepareRisuPresetImport, applyRisuPresetImport } from '../server/risu-preset-import.js';
import { putImageBlob, putValidatedImageBlob } from '../server/package-images.js';
import { nativeRisuLore, nativeRisuRegex, nativeRisuTriggers } from '../core/risu-native.js';
import { decodeRPack, encodeRPack } from '../server/compat/risu/rpack.js';
import {
  addNativeRisuImage,
  removeNativeRisuImage,
  replaceNativeRisuImage,
} from '../core/risu-native-assets.js';

const owned: { path: string; store: Store; app: FastifyInstance }[] = [];
afterEach(async () => {
  for (const { path, store, app } of owned.splice(0)) {
    await app.close();
    store.close();
    const target = resolve(path),
      within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-risu-export-')
    )
      throw new Error('Unsafe export fixture cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-risu-export-'));
  const store = new Store(join(path, 'test.sqlite')),
    app = Fastify();
  risuExportRoutes(app, store);
  owned.push({ path, store, app });
  return { store, app };
}
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJr0AAAAASUVORK5CYII=',
  'base64'
);
const source = (bytes: Buffer, name = 'source.charx') => ({
  name,
  base64: bytes.toString('base64'),
});
const card = () => ({
  name: '원본 카드',
  description: '{{char}} ORIGINAL',
  first_mes: 'Original greeting',
  alternate_greetings: ['Alternate {{user}}'],
  creator_notes: 'Creator note',
  personality: 'legacy personality',
  scenario: 'legacy scenario',
  system_prompt: 'legacy system',
  post_history_instructions: 'Global {{original}}',
  mes_example: '{{user}}: example',
  assets: [
    {
      name: 'main',
      type: 'icon',
      uri: 'embeded://assets/원본.png',
      ext: 'png',
      custom: 'retained',
    },
  ],
  character_book: { entries: [{ name: 'inline', content: 'stale inline', constant: true }] },
  extensions: {
    risuai: {
      lowLevelAccess: true,
      defaultVariables: 'stage=first',
      customScripts: [],
      triggerscript: [],
      license: 'legacy',
    },
    active: { preserved: true },
  },
  unknown_active: { nested: ['retained', true, null] },
});
function imported(store: Store, data = card(), module?: Record<string, unknown>) {
  const files = new Map([
    ['card.json', exportJson({ spec: 'chara_card_v3', spec_version: '3.0', data })],
    ['assets/원본.png', png],
  ]);
  if (module)
    files.set(
      'module.risum',
      writeEmbeddedRisuModule(
        module,
        Array.isArray(module.assets) ? module.assets.map(() => png) : []
      )
    );
  const result = analyzeNativeRisuImport(readCharacterCard(source(writeRisuZip(files))));
  for (const image of result.file.images) putValidatedImageBlob(store.product, image);
  const { id: _id, revision: _revision, ...body } = result.file.contents[0].source;
  return store.product.content(body) as Content;
}

test('edited CHARX reimports current card, canonical embedded module, image bytes and unknown authored fields', () => {
  const { store } = fixture();
  const module = {
    name: 'embedded',
    lorebook: [{ key: 'room', content: 'Room', alwaysActive: true }],
    regex: [{ in: 'OLD', out: 'NEW', type: 'editdisplay', ableFlag: true, flag: 'g', custom: 9 }],
    trigger: [
      { type: 'start', effect: [{ type: 'triggerlua', code: 'error("never execute on export")' }] },
    ],
    assets: [['scene', 'original-device-path', 'png']],
    cjs: 'obsolete',
    active: { enabled: true },
  };
  const saved = imported(store, card(), module);
  const edit = structuredClone(saved);
  edit.package.nativeRisu.card.name = '편집한 카드';
  edit.package.nativeRisu.card.first_mes = '<b>Edited {{char}}</b>';
  edit.package.nativeRisu.card.description = 'Edited description';
  edit.package.nativeRisu.module!.lorebook = [
    { key: 'room', content: 'Edited lore', alwaysActive: true },
  ];
  const replacement = putImageBlob(store.product, {
    mime: 'image/png',
    base64: Buffer.concat([png, Buffer.from('edited')]).toString('base64'),
  });
  edit.package.images![1].blobHash = replacement.hash;
  const { id: _id, revision: _revision, ...editedBody } = edit;
  const updated = store.product.content(
    { ...editedBody, expectedRevision: saved.revision },
    saved.id
  ) as Content;
  const before = store.product.export().tables;
  const output = exportRisuContent(store.product, updated);
  const read = readCharacterCard(source(output.bytes));
  expect(read.nativeCard).toMatchObject({
    name: '편집한 카드',
    description: 'Edited description',
    first_mes: '<b>Edited {{char}}</b>',
    unknown_active: card().unknown_active,
    post_history_instructions: 'Global {{original}}',
  });
  expect(read.nativeCard).not.toHaveProperty('personality');
  expect(read.nativeCard).not.toHaveProperty('scenario');
  expect(read.nativeCard).not.toHaveProperty('system_prompt');
  expect(read.nativeModule).not.toHaveProperty('cjs');
  const { cjs: _cjs, ...activeModule } = module;
  expect(read.nativeModule).toMatchObject({
    ...activeModule,
    lorebook: edit.package.nativeRisu.module!.lorebook,
  });
  const reimport = analyzeNativeRisuImport(read).file.contents[0].source.package!;
  expect(nativeRisuLore(reimport.nativeRisu)[0].content).toBe('Edited lore');
  expect(nativeRisuRegex(reimport.nativeRisu)).toEqual(module.regex);
  expect(nativeRisuTriggers(reimport.nativeRisu)[0]).toMatchObject(module.trigger[0]);
  const image = analyzeNativeRisuImport(read).file.images.find(
    (entry) => entry.hash === replacement.hash
  );
  expect(image?.base64).toBe(replacement.base64);
  expect(store.product.export().tables).toEqual(before);
});

test('new saved image and changed representative image export with portable asset names', () => {
  const { store } = fixture(),
    saved = imported(store);
  const blob = putImageBlob(store.product, {
    mime: 'image/png',
    base64: Buffer.concat([png, Buffer.from('portrait')]).toString('base64'),
  });
  saved.package.images!.push({
    id: 'new-image',
    title: '새 이미지',
    description: '',
    blobHash: blob.hash,
    mime: blob.mime,
    allowedUse: 'both',
  });
  saved.package.portraitImageId = 'new-image';
  const output = exportRisuContent(store.product, saved);
  const read = readCharacterCard(source(output.bytes));
  const assets = (read.nativeCard as Record<string, unknown>).assets as {
    name: string;
    uri: string;
    type: string;
  }[];
  expect(assets.find((entry) => entry.type === 'icon' && entry.name === 'main')?.uri).toContain(
    'portrait-new-image'
  );
  expect(assets.find((entry) => entry.name === '새 이미지')).toBeDefined();
  const archive = cardZip(output.bytes);
  expect(archive.get('assets/원본.png')!()).toEqual(png);
  expect(archive.get('assets/uimori/new-image.png')!()).toEqual(Buffer.from(blob.base64, 'base64'));
});

test('native asset edits export replaced bytes and a removed module asset without renumbering surviving draft URIs', () => {
  const { store } = fixture();
  const saved = imported(store, card(), {
    name: 'module',
    assets: [
      ['first', 'path-a', 'png'],
      ['second', 'path-b', 'png'],
    ],
    lorebook: [],
    regex: [],
    trigger: [],
  });
  const first = saved.package.nativeRisu.assets.find((asset) => asset.name === 'first')!;
  const second = saved.package.nativeRisu.assets.find((asset) => asset.name === 'second')!;
  const blob = putImageBlob(store.product, {
    mime: 'image/png',
    base64: Buffer.concat([png, Buffer.from('new bytes')]).toString('base64'),
  });
  const upload = {
    id: 'new',
    title: 'new',
    description: '',
    blobHash: blob.hash,
    mime: blob.mime,
    allowedUse: 'both' as const,
  };
  saved.package = removeNativeRisuImage(saved.package, first.imageId);
  saved.package = replaceNativeRisuImage(saved.package, second.imageId, upload);
  saved.package = addNativeRisuImage(saved.package, upload);
  expect(
    saved.package.nativeRisu.assets.find((asset) => asset.imageId === second.imageId)?.uri
  ).toBe(second.uri);
  const exported = exportRisuContent(store.product, saved);
  const reimported = analyzeNativeRisuImport(readCharacterCard(source(exported.bytes)));
  const native = reimported.file.contents[0].source.package!.nativeRisu;
  expect(native.module!.assets).toEqual([['second', 'path-b', 'png']]);
  expect(native.assets.some((asset) => asset.name === 'first')).toBe(false);
  expect(native.assets.some((asset) => asset.name === 'new')).toBe(true);
  expect(reimported.file.images.some((image) => image.hash === blob.hash)).toBe(true);
});

test('export rejects missing or unsafe embedded assets without dropping them', () => {
  const { store } = fixture(),
    saved = imported(store);
  for (const uri of ['embeded://missing.png', 'embeded://../outside.png', 'C:/local.png']) {
    const edited = structuredClone(saved);
    (edited.package.nativeRisu.card.assets as { uri: string }[])[0].uri = uri;
    edited.package.nativeRisu.assets[0].uri = uri;
    if (uri.includes('missing')) edited.package.nativeRisu.assets = [];
    expect(() => exportRisuContent(store.product, edited)).toThrow(/RISU_EXPORT_ASSET/);
  }
});

function importedModule(store: Store, name: string, extra: Record<string, unknown> = {}) {
  const input = writeEmbeddedRisuModule(
    { name, description: '', lorebook: [], regex: [], trigger: [], ...extra },
    Array.isArray(extra.assets) ? extra.assets.map(() => png) : []
  );
  const result = analyzeNativeRisuImport(readCharacterCard(source(input, `${name}.risum`)));
  for (const image of result.file.images) putValidatedImageBlob(store.product, image);
  const { id: _id, revision: _revision, ...body } = result.file.contents[0].source;
  return store.product.content(body) as Content;
}

test('standalone RISUM preserves authored fields, scripts and asset bytes through binary import', () => {
  const { store } = fixture();
  const saved = importedModule(store, 'module', {
    assets: [['scene', '', 'png']],
    namespace: 'scope',
    lowLevelAccess: true,
    trigger: [{ type: 'start', effect: [] }],
    customModuleToggle: 'x=X',
  });
  const before = structuredClone(saved);
  const output = exportRisuContent(store.product, saved);
  expect(output.filename).toBe('module.risum');
  const read = readCharacterCard(source(output.bytes, output.filename));
  expect(read.nativeModule).toMatchObject(before.package.nativeRisu.module!);
  expect(analyzeNativeRisuImport(read).file.images[0].base64).toBe(png.toString('base64'));
  expect(saved).toEqual(before);
});

test('linked nested modules export latest declaration-order scripts, converted lore and portable card assets without writes', () => {
  const { store } = fixture(),
    saved = imported(store);
  const child = importedModule(store, 'child', {
    lorebook: [{ key: 'child', content: 'nested', alwaysActive: true }],
    trigger: [{ type: 'start', effect: [{ type: 'triggerlua', code: 'return' }] }],
    lowLevelAccess: true,
    assets: [['scene', '', 'png']],
  });
  const parent = importedModule(store, 'parent', {
    regex: [{ in: 'old', out: 'new', type: 'editdisplay' }],
  });
  const { id, revision, ...body } = parent;
  const latest = store.product.content(
    {
      ...body,
      expectedRevision: revision,
      package: { ...body.package, modules: [{ id: child.id, revision: child.revision }] },
    },
    id
  ) as Content;
  saved.package.modules = [{ id, revision }];
  const original = structuredClone(saved);
  const before = store.product.export().tables;
  const read = readCharacterCard(source(exportRisuContent(store.product, saved).bytes));
  const module = read.nativeModule!;
  expect(module.regex).toEqual(latest.package.nativeRisu.module!.regex);
  expect(module.lorebook).toMatchObject([
    { alwaysActive: true, content: 'stale inline' },
    { key: 'child', content: 'nested' },
  ]);
  expect((read.nativeCard as Record<string, any>).extensions.risuai.defaultVariables).toBe(
    'stage=first'
  );
  expect((read.nativeCard as Record<string, any>).extensions.risuai.lowLevelAccess).toBe(true);
  expect(
    (read.nativeCard as Record<string, any>).assets.some(
      (asset: { name: string }) => asset.name === 'scene'
    )
  ).toBe(true);
  const restored = analyzeNativeRisuImport(read);
  expect(
    nativeRisuTriggers(restored.file.contents[0].source.package!.nativeRisu)[0].lowLevelAccess
  ).toBe(true);
  expect(store.product.export().tables).toEqual(before);
  expect(saved).toEqual(original);
});

test('linked modules reject mixed permissions, scoped metadata, missing payload and asset name conflicts', () => {
  const { store } = fixture();
  for (const extra of [
    { namespace: 'separate-scope' },
    { assets: [['main', '', 'png']] },
    { trigger: [{ type: 'start', effect: [] }], lowLevelAccess: false },
  ]) {
    const saved = imported(store, card(), { trigger: [{ type: 'start', effect: [] }] });
    const dependency = importedModule(store, 'dependency', extra);
    saved.package.modules = [{ id: dependency.id, revision: dependency.revision }];
    expect(() => exportRisuContent(store.product, saved)).toThrow('RISU_EXPORT_MODULE_CONFLICT');
  }
  const saved = imported(store);
  const dependency = importedModule(store, 'missing', { assets: [['scene', '', 'png']] });
  dependency.package.nativeRisu.assets = [];
  dependency.package.images = [];
  const { id, revision, ...body } = dependency;
  store.product.content({ ...body, expectedRevision: revision }, id);
  saved.package.modules = [{ id, revision }];
  expect(() => exportRisuContent(store.product, saved)).toThrow('RISU_EXPORT_ASSET_UNAVAILABLE');
  const empty = structuredClone(dependency);
  delete empty.package.nativeRisu.module;
  expect(() => exportRisuContent(store.product, empty)).toThrow('RISU_EXPORT_MODULE_UNSUPPORTED');
});

test('saved edited RISUP uses the real binary importer and preserves authored blocks, CBS, settings and regex', () => {
  const { store } = fixture();
  const document = {
    name: 'Original',
    promptTemplate: [{ type: 'plain', role: 'system', text: 'Original' }, { type: 'chat' }],
    regex: [{ in: 'x', out: '{{getvar::x}}', type: 'editprocess' }],
    customPromptTemplateToggle: 'style=Style=select=Calm,Bold',
    templateDefaultVariables: 'x=1',
    promptSettings: { utilOverride: false },
    openAIKey: 'do-not-export',
    aiModel: 'not-a-prompt',
  };
  const input = source(exportJson(document), 'source.json');
  const preview = prepareRisuPresetImport({ source: input });
  const saved = applyRisuPresetImport(store, {
    source: input,
    digest: preview.digest,
    allowPartial: true,
    idempotencyKey: 'export-preset',
  }).preset;
  saved.title = '편집한 프리셋';
  (saved.program.nativeRisuPreset.preset.promptTemplate as Record<string, unknown>[])[0].text =
    'Edited {{getvar::x}}';
  const { id: _id, revision: _revision, ...editedBody } = saved;
  const updated = store.product.promptPreset(
    { ...editedBody, expectedRevision: saved.revision },
    saved.id
  ) as PromptPreset;
  const before = store.product.export().tables,
    output = exportRisuPrompt(updated);
  const decoded = readRisuPresetFile(source(output.bytes, output.filename)).preset;
  expect(decoded).toMatchObject({
    name: '편집한 프리셋',
    regex: document.regex,
    promptSettings: document.promptSettings,
    templateDefaultVariables: 'x=1',
  });
  expect((decoded.promptTemplate as Record<string, unknown>[])[0].text).toBe(
    'Edited {{getvar::x}}'
  );
  expect(decoded).not.toHaveProperty('openAIKey');
  expect(decoded).not.toHaveProperty('aiModel');
  expect(
    prepareRisuPresetImport({ source: source(output.bytes, output.filename) }).summary.blocks
  ).toBe(2);
  expect(store.product.export().tables).toEqual(before);
});

test('saving and exporting a historical RISUP silently removes retired execution data without changing its input', () => {
  const { store } = fixture();
  const preset = {
    promptTemplate: [
      { type: 'jailbreak', text: 'RETIRED_JAILBREAK' },
      { type: 'plain', role: 'system', text: 'ACTIVE' },
      { type: 'cot', text: 'RETIRED_COT' },
      { type: 'chat' },
    ],
    jailbreakToggle: true,
    chainOfThought: true,
    promptSettings: {
      utilOverride: false,
      sendName: true,
      sendChatAsSystem: true,
      postEndInnerFormat: 'RETIRED_POST_END',
      assistantPrefill: 'RETIRED_PREFILL',
    },
  };
  const body = {
    title: 'Historical preset',
    role: 'main',
    program: {
      version: 1,
      nativeRisuPreset: { version: 1, preset },
    },
  };
  const before = structuredClone(body);
  const saved = store.product.promptPreset(body) as PromptPreset;
  const clean = {
    promptTemplate: [preset.promptTemplate[1], preset.promptTemplate[3]],
    promptSettings: { utilOverride: false },
  };
  expect(saved.program.nativeRisuPreset.preset).toEqual(clean);
  // Export must also normalize already-saved history, even without a new save first.
  const historical = structuredClone(saved);
  historical.program.nativeRisuPreset.preset = structuredClone(preset);
  const output = exportRisuPrompt(historical);
  expect(readRisuPresetFile(source(output.bytes, output.filename)).preset).toEqual({
    ...clean,
    name: 'Historical preset',
  });
  expect(historical.program.nativeRisuPreset.preset).toEqual(preset);
  expect(body).toEqual(before);
});

test('download routes guard revision and hidden items and return a Unicode attachment without modifying data', async () => {
  const { store, app } = fixture(),
    saved = imported(store);
  const before = store.product.export().tables;
  const response = await app.inject(
    `/api/content/${saved.id}/risu-export?expectedRevision=${saved.revision}`
  );
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-disposition']).toContain("filename*=UTF-8''");
  expect(response.headers['cache-control']).toBe('no-store');
  expect(
    (readCharacterCard(source(response.rawPayload)).nativeCard as Record<string, unknown>).name
  ).toBe(saved.title);
  expect(
    (await app.inject(`/api/content/${saved.id}/risu-export?expectedRevision=999`)).statusCode
  ).toBe(409);
  expect(store.product.export().tables).toEqual(before);
  store.db.prepare('INSERT INTO library_hidden(kind,id) VALUES(?,?)').run('content', saved.id);
  expect((await app.inject(`/api/content/${saved.id}/risu-export`)).statusCode).toBe(404);
});

test('encoder is the inverse of the pinned Risu RPack codec for every byte', () => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  expect(decodeRPack(encodeRPack(bytes))).toEqual(bytes);
});
