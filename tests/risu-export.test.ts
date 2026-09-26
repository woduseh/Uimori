import { afterEach, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sharp from 'sharp';
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
import { putImageBlob, putValidatedImageBlob } from '../server/package-images.js';
import { decodeRPack, encodeRPack } from '../server/compat/risu/rpack.js';
import { prepareRisuImport, applyRisuImport } from '../server/risu-import.js';
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

test('large imported images export and reimport within the same ZIP and module budgets', async () => {
  const { store } = fixture();
  const small = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#123456' } })
    .webp()
    .toBuffer();
  // Unknown RIFF chunks are valid WebP and stay intact when already-encoded assets are stored.
  const images = [1, 2].map((fill) => {
    const chunk = Buffer.alloc(8),
      padding = Buffer.alloc(33 * 1024 * 1024, fill);
    chunk.write('JUNK');
    chunk.writeUInt32LE(padding.length, 4);
    const bytes = Buffer.concat([small, chunk, padding]);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    return bytes;
  });
  const data = {
    name: 'Large image material',
    description: '',
    assets: images.map((_, index) => ({
      name: index === 0 ? 'main' : `image-${index}`,
      uri: `embeded://assets/${index}.webp`,
      type: index === 0 ? 'icon' : 'other',
      ext: 'webp',
    })),
  };
  const files = new Map([
    ['card.json', exportJson({ spec: 'chara_card_v3', data })],
    ...images.map((bytes, index): [string, Buffer] => [`assets/${index}.webp`, bytes]),
  ]);
  const container = writeRisuZip(files);
  const input = { name: 'large.charx', uploadId: 'large-memory-fixture' };
  const preview = prepareRisuImport({ source: input }, () => container);
  const applied = await applyRisuImport(
    store,
    {
      source: input,
      digest: preview.digest,
      allowPartial: false,
      idempotencyKey: 'large-roundtrip',
    },
    () => container
  );
  const saved = store.product.get<Content>('content', applied.receipt.items[0].id);
  const exported = exportRisuContent(store.product, saved);
  const read = readCharacterCard(
    { name: exported.filename, uploadId: 'exported-memory-fixture' },
    undefined,
    () => exported.bytes
  );
  const reimported = analyzeNativeRisuImport(read);
  expect(reimported.preview.summary.images).toBe(2);
  expect(reimported.file.images.map((image) => image.hash)).toEqual(
    saved.package.images!.map((image) => image.blobHash)
  );
  const members = cardZip(exported.bytes);
  for (const [index, image] of images.entries())
    expect(members.get(`assets/${index}.webp`)?.().equals(image)).toBe(true);
  const module = writeEmbeddedRisuModule(
    {
      name: 'Large standalone module',
      assets: images.map((_, index) => [`image-${index}`, '', 'webp']),
    },
    images
  );
  const moduleInput = readCharacterCard(
    { name: 'large.risum', uploadId: 'module-memory-fixture' },
    undefined,
    () => module
  );
  expect(analyzeNativeRisuImport(moduleInput).preview.summary.images).toBe(2);
});

test('ZIP export keeps enough compression when expanded entries exceed the upload limit', () => {
  const payload = Buffer.alloc(50 * 1024 * 1024, 1);
  const files = new Map(Array.from({ length: 6 }, (_, index) => [`assets/${index}.bin`, payload]));
  const exported = writeRisuZip(files);
  expect(exported.length).toBeLessThanOrEqual(256 * 1024 * 1024);
  const read = cardZip(exported);
  expect(read.size).toBe(files.size);
  for (const [name, bytes] of files) expect(read.get(name)?.().equals(bytes)).toBe(true);
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

test('encoder is the inverse of the pinned Risu RPack codec for every byte', () => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  expect(decodeRPack(encodeRPack(bytes))).toEqual(bytes);
});

test('RISUP text uses the preset import budget instead of the smaller card JSON budget', () => {
  const text = 'a'.repeat(9 * 1024 * 1024);
  const output = exportRisuPrompt({
    id: 'large-preset',
    revision: 1,
    title: 'Large preset',
    role: 'main',
    program: {
      version: 1,
      nativeRisuPreset: {
        version: 1,
        preset: {
          promptTemplate: [{ type: 'plain', role: 'system', text }],
        },
      },
    },
  });
  const read = readRisuPresetFile(source(output.bytes, output.filename));
  expect((read.preset.promptTemplate as { text: string }[])[0].text).toBe(text);
});
