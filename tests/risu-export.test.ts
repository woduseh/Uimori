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

test('export rejects missing or unsafe embedded assets and linked/standalone modules without dropping them', () => {
  const { store } = fixture(),
    saved = imported(store);
  for (const uri of ['embeded://missing.png', 'embeded://../outside.png', 'C:/local.png']) {
    const edited = structuredClone(saved);
    (edited.package.nativeRisu.card.assets as { uri: string }[])[0].uri = uri;
    edited.package.nativeRisu.assets[0].uri = uri;
    if (uri.includes('missing')) edited.package.nativeRisu.assets = [];
    expect(() => exportRisuContent(store.product, edited)).toThrow(/RISU_EXPORT_ASSET/);
  }
  saved.package.modules = [{ id: 'linked-module', revision: 1 }];
  expect(() => exportRisuContent(store.product, saved)).toThrow('RISU_EXPORT_LINKED_MODULES');
  saved.kind = 'module';
  expect(() => exportRisuContent(store.product, saved)).toThrow('RISU_EXPORT_MODULE_UNSUPPORTED');
});

test('saved edited RISUP uses the real binary importer and preserves authored blocks, CBS, settings and regex', () => {
  const { store } = fixture();
  const document = {
    name: 'Original',
    promptTemplate: [{ type: 'plain', role: 'system', text: 'Original' }, { type: 'chat' }],
    regex: [{ in: 'x', out: '{{getvar::x}}', type: 'editprocess' }],
    customPromptTemplateToggle: 'style=Style=select=Calm,Bold',
    templateDefaultVariables: 'x=1',
    promptSettings: { assistantPrefill: '{{char}}:' },
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
