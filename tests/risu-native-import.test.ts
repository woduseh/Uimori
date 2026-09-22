import { afterEach, expect, test } from 'vitest';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { decodeImage } from '../server/package-images.js';
import { readCharacterCard } from '../server/character-card-file.js';
import { analyzeNativeRisuImport } from '../server/risu-native-import.js';
import { applyRisuImport, prepareRisuImport } from '../server/risu-import.js';
import { decodeRPack } from '../server/compat/risu/rpack.js';
import {
  nativeRisuLore,
  nativeRisuRegex,
  nativeRisuTriggers,
  normalizeRisuContentSource,
  validateRisuContentSource,
} from '../core/risu-native.js';
import { validateRisuContent } from '../core/risu-content.js';
import type { Content } from '../core/product.js';

import { createNativeRisuCbs } from '../server/risu-native-cbs.js';
import { supportedNativeRisuSnapshot } from '../server/risu-native-readonly.js';
import { writeRisuZip } from '../server/risu-export-codec.js';

const stores: { store: Store; directory: string }[] = [];
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-native-risu-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  stores.push({ store, directory });
  return store;
}
afterEach(() => {
  for (const { store, directory } of stores.splice(0)) {
    store.close();
    const path = resolve(directory),
      within = relative(resolve(tmpdir()), path);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-native-risu-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
const sourceOf = (card: unknown) => ({
  name: 'native.json',
  base64: Buffer.from(JSON.stringify(card)).toString('base64'),
});

test('retired native fields are stripped from current saves and cannot execute through historical CBS', () => {
  const obsolete = '{{setvar::retired::executed}}retired content';
  const native = {
    version: 1 as const,
    sourceHash: 'a'.repeat(64),
    assets: [],
    card: {
      name: 'Policy fixture',
      description: 'Active description',
      mes_example: 'Active examples',
      personality: obsolete,
      scenario: obsolete,
      system_prompt: obsolete,
      nickname: 'old',
      source: ['old'],
      group_only_greetings: ['old'],
      extensions: {
        risuai: {
          additionalText: obsolete,
          license: 'old',
          virtualscript: obsolete,
          backgroundHTML: '<b>active</b>',
          unknownActive: true,
        },
      },
    },
    module: { cjs: obsolete, trigger: [], unknownActive: true },
  };
  const before = structuredClone(native);
  const normalized = normalizeRisuContentSource(native);
  expect(normalized.card).toEqual({
    name: 'Policy fixture',
    description: 'Active description',
    mes_example: 'Active examples',
    extensions: { risuai: { backgroundHTML: '<b>active</b>', unknownActive: true } },
  });
  expect(normalized.module).toEqual({ trigger: [], unknownActive: true });
  expect(validateRisuContentSource(native)).toEqual(before);
  const variables = {};
  const cbs = createNativeRisuCbs({
    native,
    variables,
    mainPrompt: obsolete,
    jailbreak: obsolete,
  });
  expect(cbs.parse('{{personality}}|{{scenario}}|{{mainprompt}}|{{jb}}')).toBe('|||');
  expect(variables).toEqual({});
  expect(native).toEqual(before);
});
const synthetic = () => ({
  name: 'Native pilot',
  description: '{{#if {{getvar::phase}}}}<b>Ready</b>{{/if}}',
  first_mes: '<div class="chooser">{{image::main}} {{getvar::phase}}</div>',
  alternate_greetings: ['Second {{char}}'],
  creator_notes: 'notes',
  character_book: {
    entries: [{ name: 'Entry', content: 'Lore {{getvar::phase}}', constant: true }],
  },
  extensions: {
    risuai: {
      backgroundHTML: '<style>.chooser{color: red}</style>',
      defaultVariables: 'phase=ready',
      customScripts: [
        {
          in: 'hello',
          out: '<b>{{char}}</b>',
          type: 'editdisplay',
          flag: 'g',
          ableFlag: true,
          custom: { preserved: true },
        },
      ],
      triggerscript: [
        {
          type: 'start',
          effect: [{ type: 'triggerlua', code: 'error("must not run on import")' }],
        },
      ],
    },
  },
  unknown: { nested: [true, null, 1, 'original'] },
});

function createNativeContent(store: Store, card = synthetic()) {
  const { file } = analyzeNativeRisuImport(readCharacterCard(sourceOf(card)));
  const { id: _id, revision: _revision, ...body } = file.contents[0].source;
  return store.product.content(body) as Content;
}

test.each(['json', 'charx'])(
  'explicit persona %s imports preserve cards without creating a chat',
  async (format) => {
    const store = database(),
      card = synthetic();
    const source =
      format === 'json'
        ? sourceOf(card)
        : {
            name: 'persona.charx',
            base64: writeRisuZip(
              new Map([
                ['card.json', Buffer.from(JSON.stringify({ spec: 'chara_card_v3', data: card }))],
              ])
            ).toString('base64'),
          };
    const preview = prepareRisuImport({ source, kind: 'persona' });
    expect(preview.kind).toBe('persona');
    expect(prepareRisuImport({ source }).kind).toBe('bot');
    const request = {
      source,
      kind: 'persona',
      digest: preview.digest,
      allowPartial: true,
      idempotencyKey: 'persona',
    };
    const result = await applyRisuImport(store, request);
    expect(result.chat).toBeNull();
    expect(result.receipt.items[0].key).toBe('persona');
    const saved = store.product.get<Content>('content', result.receipt.items[0].id);
    expect(saved.kind).toBe('persona');
    expect(saved.text).toBe(card.description);
    expect(saved.package.nativeRisu.card).toEqual(card);
    expect(saved.package.starts?.[0].text).toBe(card.first_mes);
    expect(saved.package.variableDefaults).toEqual({
      values: { phase: 'ready' },
      attachmentRoles: ['persona'],
    });
    expect(await applyRisuImport(store, request)).toMatchObject({
      chat: null,
      receipt: { created: false },
    });
    expect(store.db.prepare('SELECT count(*) AS n FROM chats').get()!.n).toBe(0);
    expect(async () => await applyRisuImport(store, { ...request, kind: 'bot' })).toThrow(
      'RISU_IMPORT_DRAFT_CHANGED'
    );

    const bot = createNativeContent(store);
    const chat = store.createChat('Persona snapshot', undefined, { botId: bot.id });
    const profile = store.product.snapshot(chat.id);
    profile.packages = [saved.package];
    profile.packageAttachments = [
      { id: saved.package.id, revision: saved.package.revision, role: 'persona' },
    ];
    const snapshot = {
      chatId: chat.id,
      parentRevision: null,
      settingsRevision: chat.settingsRevision,
      settings: chat.settings,
      request: 'Continue',
      history: [],
      resources: [],
      profile,
    };
    const refreshed = supportedNativeRisuSnapshot(snapshot);
    expect(refreshed.profile!.packages![0].variableDefaults).toEqual(
      saved.package.variableDefaults
    );
    expect(refreshed.profile!.packages![0].body).toBe(card.description);
    expect(refreshed.profile!.packages![0].identity).toBeUndefined();
  }
);

test('persona import rejects standalone modules and malformed cards', () => {
  const module = { name: 'Module', lorebook: [], regex: [] };
  const document = { type: 'risuModule', module };
  const sources = [
    sourceOf(document),
    { name: 'module.risum', base64: binaryModule(module, []).toString('base64') },
    {
      name: 'project.zip',
      base64: writeRisuZip(
        new Map([['module.json', Buffer.from(JSON.stringify(document))]])
      ).toString('base64'),
    },
  ];
  for (const source of sources) {
    expect(prepareRisuImport({ source }).kind).toBe('module');
    expect(() => prepareRisuImport({ source, kind: 'persona' })).toThrow('RISU_IMPORT_KIND');
  }
  expect(() =>
    prepareRisuImport({ source: sourceOf({ name: 'Missing body' }), kind: 'persona' })
  ).toThrow('RISU_IMPORT_INVALID_FILE');
});

test('effective trigger permission belongs to the character or standalone module without changing raw flags', () => {
  const { file } = analyzeNativeRisuImport(readCharacterCard(sourceOf(synthetic())));
  const native = file.contents[0].source.package!.nativeRisu!;
  native.module = { lowLevelAccess: true, trigger: [{ type: 'start', lowLevelAccess: true }] };
  const before = structuredClone(native);
  expect(nativeRisuTriggers(native)[0].lowLevelAccess).toBe(false);
  expect(nativeRisuTriggers({ ...native, card: {} })[0].lowLevelAccess).toBe(true);
  expect(native).toEqual(before);
  native.card.extensions = { risuai: { lowLevelAccess: true } };
  native.module.lowLevelAccess = false;
  native.module.trigger = [{ type: 'start', lowLevelAccess: false }];
  expect(nativeRisuTriggers(native)[0].lowLevelAccess).toBe(true);
  expect(nativeRisuTriggers({ ...native, card: {} })[0].lowLevelAccess).toBe(false);
});

test('native edits reproject canonical source, preserve unknown fields and retain revision conflicts', () => {
  const store = database(),
    saved = createNativeContent(store);
  const { id, revision, ...body } = structuredClone(saved);
  const native = body.package!.nativeRisu!;
  native.card.name = 'Edited native';
  native.card.description = 'Changed {{char}}';
  native.card.creator_notes = '';
  native.card.first_mes = '<section>New opening</section>';
  native.card.character_book = {
    entries: [{ name: 'New lore', content: 'NEW RAW {{char}}', constant: true }],
  };
  body.title = 'stale title';
  body.text = 'stale body';
  body.package!.starts = [{ id: 'forged', title: 'Wrong', mode: 'authored', text: 'stale start' }];
  body.package!.loreActivation = { mode: 'discoverable' };
  const request = { ...body, expectedRevision: revision };
  const untouched = structuredClone(request);
  const updated = store.product.content(request, id) as Content;
  expect(request).toEqual(untouched);
  expect(updated.title).toBe('Edited native');
  expect(updated.description).toBe('');
  expect(updated.text).toBe('Changed {{char}}');
  expect(updated.package!.starts![0].text).toBe('<section>New opening</section>');
  expect(updated.package!.lore[0].text).toBe('NEW RAW {{char}}');
  expect(updated.package!.loreActivation!.mode).toBe('discoverable');
  expect(updated.package!.nativeRisu!.card.unknown).toEqual(synthetic().unknown);
  expect(store.product.get<Content>('content', id, revision)).toEqual(saved);
  expect(() => store.product.content(request, id)).toThrow(/Revision conflict/);
});

test('content saves reject retired Uimori instructions without modifying the current record', () => {
  const store = database();
  const saved = createNativeContent(store);
  const { id, revision, ...body } = structuredClone(saved);
  const request = {
    ...body,
    expectedRevision: revision,
    package: {
      ...body.package,
      instructions: [{ id: 'card-system', target: 'main', text: 'RETIRED_SYSTEM' }],
    },
  };
  expect(() => store.product.content(request, id)).toThrow('PACKAGE_INVALID_FIELDS');
  expect(store.product.get<Content>('content', id)).toEqual(saved);
});

test('embedded module selection distinguishes absent/null/empty lore without mutating either source', () => {
  const card = synthetic();
  const native = { version: 1 as const, card, assets: [], sourceHash: 'a'.repeat(64) };
  const selected = { ...native, module: { regex: [], trigger: [], lorebook: [] } };
  expect(nativeRisuRegex(selected)).toEqual([]);
  expect(nativeRisuTriggers(selected)).toEqual([]);
  expect(nativeRisuLore(selected)).toEqual([]);
  expect(nativeRisuLore({ ...selected, module: { lorebook: null } })).toEqual(
    card.character_book.entries
  );
  expect(nativeRisuLore({ ...selected, module: {} })).toEqual(card.character_book.entries);
  expect(card).toEqual(synthetic());
});

test('a card without first_mes keeps an empty chat even when alternate greetings exist', async () => {
  const card = { ...synthetic(), first_mes: '' };
  const source = sourceOf(card),
    store = database();
  const preview = prepareRisuImport({ source });
  const result = await applyRisuImport(store, {
    source,
    digest: preview.digest,
    allowPartial: true,
    idempotencyKey: 'no-first-message',
  });
  expect(result.chat!.headRevision).toBeNull();
  expect(
    store.db.prepare('SELECT count(*) AS n FROM runs WHERE chat_id=?').get(result.chat!.id)!.n
  ).toBe(0);
  expect(
    store.product
      .get<Content>('content', result.receipt.items[0].id)
      .package!.starts!.map((start) => start.id)
  ).toEqual(['start-1']);
});

const encodeMap = Buffer.alloc(256);
for (const [encoded, plain] of decodeRPack(
  Buffer.from(Array.from({ length: 256 }, (_, i) => i))
).entries())
  encodeMap[plain] = encoded;
function binaryModule(module: Record<string, unknown>, assets: Buffer[]) {
  const payload = (bytes: Buffer) => {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(bytes.length);
    return Buffer.concat([size, Buffer.from(bytes.map((value) => encodeMap[value]))]);
  };
  return Buffer.concat([
    Buffer.from([111, 0]),
    payload(Buffer.from(JSON.stringify({ type: 'risuModule', module }))),
    ...assets.map((bytes) => Buffer.concat([Buffer.from([1]), payload(bytes)])),
    Buffer.from([0]),
  ]);
}
test('standalone risum retains source scripts and maps ordered embedded image bytes', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
    'base64'
  );
  const module = {
    name: 'Module',
    lorebook: [],
    assets: [['main', 'assets/old.png', 'png']],
    regex: [{ in: 'a', out: 'b', type: 'editdisplay' }],
  };
  const bytes = binaryModule(module, [png]);
  const input = readCharacterCard({ name: 'native.risum', base64: bytes.toString('base64') });
  const { file, preview } = analyzeNativeRisuImport(input);
  expect(preview.format).toBe('risu-module-binary');
  expect(preview.kind).toBe('module');
  expect(file.contents[0].source.package!.nativeRisu).toMatchObject({
    card: {},
    module,
    assets: [{ name: 'main', imageId: 'image-0' }],
  });
  expect(file.images[0].base64).toBe(png.toString('base64'));
  expect(file.sourceFiles![0].base64).toBe(bytes.toString('base64'));
  expect(() =>
    readCharacterCard({ name: 'native.risum', base64: bytes.toString('base64') }, 'bot')
  ).toThrow('RISU_IMPORT_KIND');
});

test('native envelope validation rejects invalid source, non-JSON values and unresolved image references', () => {
  const { file } = analyzeNativeRisuImport(readCharacterCard(sourceOf(synthetic())));
  const pkg = file.contents[0].source.package!;
  expect(() =>
    validateRisuContent({ ...pkg, nativeRisu: { ...pkg.nativeRisu, sourceHash: 'invalid' } })
  ).toThrow('PACKAGE_NATIVE_RISU_INVALID');
  expect(() => validateRisuContentSource({ ...pkg.nativeRisu, card: { fn: () => 1 } })).toThrow(
    'PACKAGE_NATIVE_RISU_JSON'
  );
  expect(() =>
    validateRisuContent({
      ...pkg,
      nativeRisu: {
        ...pkg.nativeRisu,
        assets: [{ name: 'lost', uri: 'embeded://lost.png', imageId: 'lost' }],
      },
    })
  ).toThrow('PACKAGE_NATIVE_RISU_ASSET_REFERENCE');
});

test('AVIF brand validation and GIF signatures cannot be confused with arbitrary image bytes', () => {
  const avif = Buffer.alloc(32);
  avif.writeUInt32BE(24);
  avif.write('ftyp', 4);
  avif.write('mif1', 8);
  avif.write('avif', 16);
  expect(decodeImage('image/avif', avif.toString('base64')).bytes).toEqual(avif);
  const wrong = Buffer.from(avif);
  wrong.write('mp42', 16);
  expect(() => decodeImage('image/avif', wrong.toString('base64'))).toThrow('Invalid image bytes');
  wrong.writeUInt32BE(128);
  expect(() => decodeImage('image/avif', wrong.toString('base64'))).toThrow('Invalid image bytes');
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  expect(decodeImage('image/gif', gif.toString('base64')).bytes).toEqual(gif);
  expect(() => decodeImage('image/avif', gif.toString('base64'))).toThrow('Invalid image bytes');
  expect(() => decodeImage('image/gif', gif.subarray(0, -1).toString('base64'))).toThrow(
    'Invalid image bytes'
  );
});

// Opt-in local evidence only: no private card or machine path enters repository fixtures.
