import { afterEach, expect, test } from 'vitest';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Store } from '../server/store.js';
import { decodeImage } from '../server/package-images.js';
import { readCharacterCard } from '../server/character-card-file.js';
import { analyzeNativeRisuImport } from '../server/risu-native-import.js';
import { applyRisuImport, prepareRisuImport } from '../server/risu-import.js';
import {
  applyNativeTransfer,
  exportNativeTransfer,
  nativeTransferOriginal,
  prepareNativeTransfer,
} from '../server/native-transfer.js';
import { decodeRPack } from '../server/compat/risu/rpack.js';
import {
  nativeRisuBackground,
  nativeRisuLore,
  nativeRisuRegex,
  nativeRisuTriggers,
  normalizeRisuContentSource,
  validateRisuContentSource,
} from '../core/risu-native.js';
import { validateRisuContent } from '../core/risu-content.js';
import type { Content } from '../core/product.js';
import { EditDraftService, initEditDrafts } from '../server/edit-drafts.js';
import { nativeRisuPreview } from '../server/risu-native-preview.js';
import { createNativeRisuCbs } from '../server/risu-native-cbs.js';

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

test('new reservations reproject old library fields without rewriting their stored source', () => {
  const store = database();
  const saved = createNativeContent(store);
  const historical = structuredClone(saved);
  historical.package!.nativeRisu.card.personality = 'RETIRED_PERSONALITY';
  historical.package!.nativeRisu.card.scenario = 'RETIRED_SCENARIO';
  historical.package!.nativeRisu.card.system_prompt = 'RETIRED_SYSTEM';
  historical.package!.body = `${historical.package!.body}\nRETIRED_PERSONALITY\nRETIRED_SCENARIO`;
  historical.package!.instructions = [
    { id: 'card-system', target: 'main', text: 'RETIRED_SYSTEM' },
  ];
  historical.text = historical.package!.body!;
  store.db
    .prepare("UPDATE versions SET body=? WHERE kind='content' AND id=? AND revision=?")
    .run(JSON.stringify(historical), historical.id, historical.revision);
  const chat = store.createChat('Old library new request', undefined, { botId: saved.id });
  const profile = store.product.snapshot(chat.id);
  const active = profile.packages!.find((item) => item.id === saved.id)!;
  expect(active.body).toBe(saved.package!.body);
  expect(active.instructions).toEqual([]);
  expect(JSON.stringify(active)).not.toContain('RETIRED_');
  expect(store.product.get<Content>('content', saved.id)).toEqual(historical);
  const run = store.createRun(
    chat.id,
    {
      request: 'Continue',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: 'supported-fields',
    },
    () => ({
      chatId: chat.id,
      parentRevision: null,
      settingsRevision: chat.settingsRevision,
      settings: chat.settings,
      request: 'Continue',
      history: [],
      profile,
      resources: store.product.resources(chat.id, profile),
    })
  ).run;
  store.startRun(run.id);
  store.completeRun(
    run.id,
    'Authored fixture response.',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    chat.settings
  );
  const restored = database();
  expect(() => restored.product.import(store.product.export())).not.toThrow();
  expect(restored.product.get<Content>('content', saved.id)).toEqual(historical);
  expect(restored.run(run.id).snapshot.profile!.packages).toEqual(profile.packages);
});

test('native draft supports large preserved documents and incomplete raw buffers without saving them', () => {
  const store = database();
  const card = synthetic();
  card.unknown.nested = ['x'.repeat(5_100_000)];
  const saved = createNativeContent(store, card);
  initEditDrafts(store);
  const service = new EditDraftService(store),
    authority = { requestId: 'native-editor', assert: () => {} };
  const { id: _id, revision: _revision, ...model } = saved;
  const draft = service.create(
    {
      editorKey: `content:${saved.id}`,
      kind: 'content',
      targetId: saved.id,
      model,
      operationId: 'native-create',
    },
    authority
  );
  expect(service.validate(draft.id).valid).toBe(true);
  const buffer = '{"unfinished":"' + 'x'.repeat(1_100_000);
  service.patch(
    draft.id,
    {
      expectedRevision: draft.revision,
      operationId: 'native-patch',
      model,
      rawFields: { 'package.native.source': buffer },
      unappliedFields: ['package.native.source'],
    },
    authority
  );
  expect(service.get(draft.id).rawFields['package.native.source']).toBe(buffer);
  expect(service.validate(draft.id).valid).toBe(false);
  expect(store.product.get<Content>('content', saved.id).revision).toBe(saved.revision);
  expect(() =>
    service.create(
      {
        editorKey: 'new:content:bot',
        kind: 'content',
        targetId: null,
        model: { ...model, package: undefined, text: 'x'.repeat(5_100_000) },
        operationId: 'ordinary-limit',
      },
      authority
    )
  ).toThrow('Draft model too large');
});

test('start preview uses fresh display Lua, CBS and regex without creating chat state', async () => {
  const store = database(),
    card = synthetic();
  card.first_mes = 'hello';
  card.extensions.risuai.triggerscript = [
    {
      type: 'start',
      effect: [
        {
          type: 'triggerlua',
          code: `
local count = 0
listenEdit('editDisplay', function(id, text)
  count = count + 1
  setChatVar(id, 'phase', 'preview')
  return text .. ' {{user}} {{getvar::phase}} ' .. count
end)
`,
        },
      ],
    },
  ];
  const saved = createNativeContent(store, card);
  const before = store.product.export();
  const query = { revision: String(saved.revision), startId: 'start-0', userName: 'Visitor' };
  const first = await nativeRisuPreview(store, saved.id, query);
  expect(first.html).toContain('<b>Native pilot</b>');
  expect(first.html).toContain('Visitor preview 1');
  expect(first.html).toContain('.chooser{color: red}');
  expect(await nativeRisuPreview(store, saved.id, query)).toEqual(first);
  expect(store.product.export().tables).toEqual(before.tables);
  await expect(
    nativeRisuPreview(store, saved.id, { ...query, startId: 'missing' })
  ).rejects.toThrow('Authored start not found');
});

test('native card remains the exact authored document through import, original export and backup', () => {
  const card = synthetic(),
    source = sourceOf({ spec: 'chara_card_v3', data: card });
  const store = database(),
    preview = prepareRisuImport({ source });
  expect(store.db.prepare('SELECT count(*) AS n FROM chats').get()!.n).toBe(0);
  const result = applyRisuImport(store, {
    source,
    digest: preview.digest,
    allowPartial: true,
    idempotencyKey: 'native',
  });
  const pkg = store.product.get<Content>('content', result.receipt.items[0].id).package!;
  expect(result.chat!.headRevision).not.toBeNull();
  expect(store.sourceOriginal(result.chat!.headRevision!).text).toBe(card.first_mes);
  expect(
    store.db.prepare('SELECT count(*) AS n FROM runs WHERE chat_id=?').get(result.chat!.id)!.n
  ).toBe(1);
  const replay = applyRisuImport(store, {
    source,
    digest: preview.digest,
    allowPartial: true,
    idempotencyKey: 'native',
  });
  expect(replay.chat!.headRevision).toBe(result.chat!.headRevision);
  expect(
    store.db.prepare('SELECT count(*) AS n FROM runs WHERE chat_id=?').get(result.chat!.id)!.n
  ).toBe(1);
  expect(pkg.nativeRisu!.card).toEqual(card);
  expect(pkg.nativeRisu!.sourceHash).toBe(
    createHash('sha256').update(Buffer.from(source.base64, 'base64')).digest('hex')
  );
  expect(pkg.body).toBe(card.description);
  expect(pkg.starts!.map((start) => start.text)).toEqual([
    card.first_mes,
    ...card.alternate_greetings,
  ]);
  expect(nativeRisuRegex(pkg.nativeRisu!)).toEqual(card.extensions.risuai.customScripts);
  expect(nativeRisuTriggers(pkg.nativeRisu!)).toEqual(
    card.extensions.risuai.triggerscript.map((trigger) => ({ ...trigger, lowLevelAccess: false }))
  );
  expect(nativeRisuBackground(pkg.nativeRisu!)).toBe(card.extensions.risuai.backgroundHTML);
  expect(nativeRisuLore(pkg.nativeRisu!)).toEqual(card.character_book.entries);
  expect(nativeTransferOriginal(store, result.receipt.id).sourceFiles![0].base64).toBe(
    source.base64
  );
  const restored = database();
  restored.product.import(store.product.export());
  expect(
    restored.product.get<Content>('content', result.receipt.items[0].id).package!.nativeRisu
  ).toEqual(pkg.nativeRisu);
  expect(nativeTransferOriginal(restored, result.receipt.id).sourceFiles![0].base64).toBe(
    source.base64
  );
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

test('a card without first_mes keeps an empty chat even when alternate greetings exist', () => {
  const card = { ...synthetic(), first_mes: '' };
  const source = sourceOf(card),
    store = database();
  const preview = prepareRisuImport({ source });
  const result = applyRisuImport(store, {
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
test.runIf(Boolean(process.env.UIMORI_RISU_LOCAL_CARDS))(
  'local reference cards preserve documents, script counts and embedded assets',
  () => {
    const paths: string[] = JSON.parse(process.env.UIMORI_RISU_LOCAL_CARDS!);
    for (const path of paths) {
      const bytes = readFileSync(path);
      const input = readCharacterCard(
        { name: basename(path), uploadId: 'local-evidence' },
        undefined,
        () => bytes
      );
      const { file, preview } = analyzeNativeRisuImport(input);
      const pkg = file.contents[0].source.package!;
      const supported = normalizeRisuContentSource({
        ...pkg.nativeRisu!,
        card: input.nativeCard!,
        ...(input.nativeModule ? { module: input.nativeModule } : {}),
      });
      expect(pkg.nativeRisu!.card).toEqual(supported.card);
      expect(pkg.nativeRisu!.module).toEqual(supported.module);
      expect(pkg.starts!.length).toBeGreaterThan(0);
      expect(pkg.nativeRisu!.assets.length).toBe(pkg.images!.length);
      if (bytes.length > 64 * 1024 * 1024) {
        const store = database();
        const result = applyRisuImport(
          store,
          {
            source: input.source,
            digest: preview.digest,
            allowPartial: true,
            idempotencyKey: 'large-native-local',
          },
          () => bytes
        );
        const contentId = result.receipt.items[0].id;
        const exported = exportNativeTransfer(store, {
          items: [{ kind: 'content', id: contentId }],
        });
        expect(Buffer.byteLength(JSON.stringify(exported))).toBeGreaterThan(64 * 1024 * 1024);
        const prepared = prepareNativeTransfer({ file: exported });
        const target = database();
        const copied = applyNativeTransfer(target, {
          file: exported,
          digest: prepared.digest,
          modelBindings: [],
          idempotencyKey: 'large-native-roundtrip',
        });
        expect(
          target.product.get<Content>('content', copied.items[0].id).package!.nativeRisu
        ).toEqual(pkg.nativeRisu);
        const restored = database();
        restored.product.import(store.product.export());
        expect(restored.product.get<Content>('content', contentId).package!.nativeRisu).toEqual(
          pkg.nativeRisu
        );
        expect(nativeTransferOriginal(restored, result.receipt.id).images).toEqual(file.images);
      }
      console.info(
        JSON.stringify({
          file: basename(path),
          starts: preview.summary.starts,
          lore: preview.summary.lore,
          images: preview.summary.images,
          imageMimes: [...new Set(pkg.images!.map((image) => image.mime))],
          regex: nativeRisuRegex(pkg.nativeRisu!).length,
          triggers: nativeRisuTriggers(pkg.nativeRisu!).length,
          findings: preview.findings.map(({ code, level }) => ({ code, level })),
        })
      );
    }
  },
  60_000
);
