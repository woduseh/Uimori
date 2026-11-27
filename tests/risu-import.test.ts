import { nativePrompt } from './fixtures/native-prompt.js';
import { afterEach, expect, test } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { zip } from './fixtures/zip.js';
import { Store } from '../server/store.js';
import { applyRisuImport, prepareRisuImport, risuImportRoutes } from '../server/risu-import.js';

import type { Content } from '../core/product.js';
import { nativeRisuRegex } from '../core/risu-native.js';
import { compileContentAttachment } from '../core/package-runtime.js';
import { modelWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { writeEmbeddedRisuModule } from '../server/risu-export-codec.js';
import { convertCharbook } from '../server/compat/risu/lorebook.js';
import { createHash } from 'node:crypto';
import { cardZip } from '../server/character-card-file.js';
import { uploadDirectory, uploadRoutes } from '../server/uploads.js';
import { RISU_IMPORT_MAX_BYTES } from '../core/risu-import.js';
import { existsSync, statSync } from 'node:fs';

const owned: { directory: string; store: Store }[] = [];
afterEach(() => {
  for (const { directory, store } of owned.splice(0)) {
    store.close();
    const path = resolve(directory),
      within = relative(resolve(tmpdir()), path);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-risu-import-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-risu-import-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  owned.push({ directory, store });
  return store;
}
const card = () => ({
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: 'Synthetic Pilot',
    description: '{{char}} explores an imaginary planet.',
    first_mes: 'The pilot waits.',
    alternate_greetings: ['The ship lands.'],
    character_book: {
      entries: [
        { name: 'World', content: 'The sky is green.', constant: true, enabled: true },
        {
          name: 'History',
          content: '\nEarlier travel with {{user}}.\n',
          constant: true,
          enabled: true,
        },
      ],
    },
  },
});
const sourceOf = (value: unknown) => ({
  name: 'synthetic-card.json',
  base64: Buffer.from(JSON.stringify(value)).toString('base64'),
});

test('a replayed bot import returns its original receipt and chat', async () => {
  const store = database();
  const source = sourceOf(card());
  const preview = prepareRisuImport({ source });
  const body = { source, digest: preview.digest, allowPartial: false, idempotencyKey: 'old-risu' };
  const first = await applyRisuImport(store, body);
  expect(first.chat).not.toBeNull();
  const replay = await applyRisuImport(store, body);
  expect(replay.receipt).toMatchObject({ id: first.receipt.id, created: false });
  expect(replay.chat?.id).toBe(first.chat?.id);
  expect(store.chats()).toHaveLength(1);
  expect(store.product.all('content')).toHaveLength(1);
});

test('a library-only bot import preserves its opening without creating a chat, including retries', async () => {
  const store = database();
  const source = sourceOf(card());
  const preview = prepareRisuImport({ source });
  const body = {
    source,
    digest: preview.digest,
    allowPartial: false,
    createChat: false,
    idempotencyKey: 'library-only',
  };
  const imported = await applyRisuImport(store, body);
  expect(imported.chat).toBeNull();
  expect(store.chats()).toHaveLength(0);
  const botId = imported.receipt.items.find((item) => item.key === 'bot')!.id;
  const bot = store.product.stored<Content>('content', botId);
  expect(bot.package.starts?.[0].text).toBe('The pilot waits.');
  expect((await applyRisuImport(store, body)).receipt).toMatchObject({
    created: false,
    id: imported.receipt.id,
  });
  expect(store.product.all('content')).toHaveLength(1);
  await expect(applyRisuImport(store, { ...body, createChat: true })).rejects.toMatchObject({
    statusCode: 409,
  });
  expect(store.chats()).toHaveLength(0);
});

test('retired card fields are excluded while active global notes and source bytes remain: {{original}} Give {{char}} room to act.', async () => {
  const globalNote = '{{original}}\nGive {{char}} room to act.';
  const store = database();
  const workspace = modelWorkspace(store);
  updatePromptWorkspace(store, {
    expectedRevision: workspace.revision,
    main: {
      title: 'Selected prompt',
      program: nativePrompt('KEEP_SELECTED_MAIN'),
      values: {},
    },
  });
  const before = modelWorkspace(store),
    original = card();
  const source = sourceOf({
    ...original,
    data: {
      ...original.data,
      personality: 'EXCLUDED_PERSONALITY {{setvar::x::1}}',
      scenario: 'EXCLUDED_SCENARIO',
      system_prompt: 'EXCLUDED_MAIN',
      post_history_instructions: globalNote,
    },
  });
  const preview = prepareRisuImport({ source });
  expect(preview.findings.filter((finding) => finding.level === 'unsupported')).toEqual([]);
  const saved = await applyRisuImport(store, {
    source,
    digest: preview.digest,
    allowPartial: false,
    idempotencyKey: 'guidance',
  });
  const content = store.product.stored<Content>('content', saved.receipt.items[0].id),
    chat = saved.chat!;
  const profile = store.product.snapshot(chat.id)!;
  const compiled = compileSnapshotPrompt({
    chatId: chat.id,
    parentRevision: null,
    settingsRevision: chat.settingsRevision,
    settings: chat.settings,
    request: 'Continue.',
    history: [],
    logicalHistory: [],
    profile,
    resources: store.product.resources(chat.id, profile),
  });
  const delivered = JSON.stringify(compiled.promptCompilation!.messages);
  expect(delivered.match(/KEEP_SELECTED_MAIN/gu)).toHaveLength(1);
  expect(content.package!.nativeRisu!.card.post_history_instructions).toBe(globalNote);
  for (const key of ['personality', 'scenario', 'system_prompt'])
    expect(content.package!.nativeRisu!.card).not.toHaveProperty(key);
  expect(content.package).not.toHaveProperty('instructions');
  expect(delivered).not.toContain('EXCLUDED_');
  expect(modelWorkspace(store)).toEqual(before);
});

test('module JSON registers a reusable module without a bot, chat or memory', async () => {
  const store = database();
  const module = {
    type: 'risuModule',
    module: {
      id: 'original-module',
      name: 'Synthetic module',
      description: 'Display-only author notes.',
      lorebook: [
        {
          id: 'setting',
          key: '',
          comment: 'World',
          content: '{{user}} visits a green moon.',
          mode: 'normal',
          alwaysActive: true,
          insertorder: 200,
        },
        { id: 'folder', comment: 'Folder', mode: 'folder', content: '' },
      ],
      regex: [{ type: 'editdisplay', in: '<status>(.*?)</status>', out: '**$1**' }],
      trigger: [],
      lowLevelAccess: false,
      assets: [
        [
          'green',
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNI293xHwAF3QKpuamA4gAAAABJRU5ErkJggg==',
          'source-hash',
        ],
      ],
    },
  };
  const source = { ...sourceOf(module), name: 'module.json' },
    preview = prepareRisuImport({ source });
  expect(preview.kind).toBe('module');
  expect(preview.format).toBe('risu-module-json');
  expect(preview.summary).toEqual({ lore: 1, starts: 0, images: 1 });
  expect(preview.findings.some((item) => item.level === 'unsupported')).toBe(false);
  const body = {
    source,
    digest: preview.digest,
    allowPartial: false,
    idempotencyKey: 'module-json',
  };
  const result = await applyRisuImport(store, body);
  expect(result.chat).toBeNull();
  expect(result.receipt.items[0].category).toBe('module');
  expect(store.db.prepare('SELECT count(*) AS n FROM chats').get()!.n).toBe(0);
  const content = store.product.stored<Content>('content', result.receipt.items[0].id),
    pkg = content.package!;
  expect(content.kind).toBe('module');
  expect(pkg.identity).toBeUndefined();
  expect(pkg.body).toBe('');
  expect(pkg.portraitImageId).toBeUndefined();
  expect(pkg.lore[0].loreContext?.order).toBe(200);
  const compiled = compileContentAttachment(
    pkg,
    { id: pkg.id, revision: pkg.revision, role: 'module' },
    {
      chatId: 'synthetic',
    }
  );
  expect(compiled.resources.find((item) => item.id.endsWith(':lore:lore-0'))?.text).toBe(
    '{{user}} visits a green moon.'
  );
  expect(nativeRisuRegex(pkg.nativeRisu!)).toEqual([
    expect.objectContaining({ in: '<status>(.*?)</status>', out: '**$1**' }),
  ]);

  expect((await applyRisuImport(store, body)).receipt).toMatchObject({
    id: result.receipt.id,
    created: false,
  });
});

test('module lorebook keys, secondary keys and mode remain in authoritative Risu source', async () => {
  const store = database();
  const source = {
    ...sourceOf({
      type: 'risuModule',
      module: {
        name: 'Keyed module',
        description: '',
        lorebook: [
          {
            id: 'docks',
            comment: 'Docks',
            // https://github.com/kwaroran/RisuAI/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/characterCards.ts#L1061-L1063 (2026-11-20):
            // use_regex is reset to false unless the first key starts with `/`.
            key: '/harbor/i',
            useRegex: true,
            content: 'The docks are loud.',
            insertorder: 1,
          },
          {
            id: 'weather',
            comment: 'Weather',
            key: 'storm',
            secondkey: 'rain',
            selective: true,
            mode: 'child',
            content: 'Rain follows the storm.',
            insertorder: 2,
          },
        ],
      },
    }),
    name: 'module.json',
  };
  const preview = prepareRisuImport({ source });
  const result = await applyRisuImport(store, {
    source,
    digest: preview.digest,
    allowPartial: true,
    idempotencyKey: 'module-keyed',
  });
  const pkg = store.product.stored<Content>('content', result.receipt.items[0].id).package!;
  expect(pkg.loreActivation).toEqual({ mode: 'model' });
  expect(pkg.nativeRisu.module!.lorebook).toMatchObject([
    { key: '/harbor/i', useRegex: true },
    { key: 'storm', secondkey: 'rain', selective: true, mode: 'child' },
  ]);
  expect(pkg.lore.every((item) => !Object.hasOwn(item, 'activation'))).toBe(true);
});

test('card imports preserve all lore, trimmed like the Risu decorator reader, and cannot move it into the first chat notes', async () => {
  const store = database(),
    app = Fastify();
  risuImportRoutes(app, store);
  try {
    const source = sourceOf(card());
    const preparation = await app.inject({
      method: 'POST',
      url: '/api/risu-imports/prepare',
      payload: { source },
    });
    expect(preparation.statusCode).toBe(200);
    const preview = preparation.json();
    expect(preview.summary).toEqual({ lore: 2, starts: 2, images: 0 });
    expect(preview.lore.every((item: object) => !Object.hasOwn(item, 'memoryCandidate'))).toBe(
      true
    );
    expect(store.db.prepare('SELECT count(*) AS n FROM chats').get()!.n).toBe(0);
    const body = {
      source,
      digest: preview.digest,
      allowPartial: false,
      idempotencyKey: 'normal',
    };
    const normal = await app.inject({
      method: 'POST',
      url: '/api/risu-imports/apply',
      payload: body,
    });
    expect(normal.statusCode).toBe(201);
    const result = normal.json();
    const bot = store.product.stored<Content>('content', result.receipt.items[0].id);
    expect(bot.package!.lore).toHaveLength(2);
    expect(bot.package!.starts).toHaveLength(2);
    expect(bot.package!.body).toBe('{{char}} explores an imaginary planet.');
    const resources = store.product.resources(
      result.chat.id,
      store.product.snapshot(result.chat.id)!
    );
    expect(resources.find((item) => item.id.endsWith(':body'))?.text).toBe(
      '{{char}} explores an imaginary planet.'
    );
    expect(resources.find((item) => item.id.endsWith(':lore:lore-1'))?.text).toBe(
      'Earlier travel with {{user}}.'
    );
    expect(store.story.notes.revision(result.chat.id)).toBe(0);
    expect(JSON.stringify(bot)).not.toContain(source.base64);
    const selectedBody = { ...body, idempotencyKey: 'with-memory', memoryIds: ['lore-1'] };
    await expect(applyRisuImport(store, selectedBody)).rejects.toThrow('Unknown request field');
    expect(
      (
        bot.package!.nativeRisu.card.character_book as { entries: { enabled: boolean }[] }
      ).entries.every((entry) => entry.enabled !== false)
    ).toBe(true);
    const secondChat = store.createChat('Another chat', { botId: bot.id });
    expect(
      store.product
        .resources(secondChat.id, store.product.snapshot(secondChat.id))
        .find((item) => item.id.endsWith(':lore:lore-1'))?.text
    ).toBe('Earlier travel with {{user}}.');
    expect(store.story.notes.revision(secondChat.id)).toBe(0);

    expect(await applyRisuImport(store, body)).toMatchObject({
      receipt: { id: result.receipt.id, created: false },
      chat: { id: result.chat.id },
    });
  } finally {
    await app.close();
  }
});

test.each([null, []])(
  'embedded lore fallback distinguishes missing/null from an empty list: %j',
  (lorebook) => {
    const value = card();
    Object.assign(value.data, {
      extensions: {
        risuai: {
          customScripts: [{ type: 'editdisplay', in: 'x', out: 'inline' }],
          triggerscript: [{ type: 'unsupported' }],
        },
      },
    });
    const source = {
      name: 'card.charx',
      base64: zip([
        ['card.json', Buffer.from(JSON.stringify(value))],
        ['module.risum', writeEmbeddedRisuModule({ lorebook }, [])],
      ]).toString('base64'),
    };
    const preview = prepareRisuImport({ source });
    expect(preview.summary.lore).toBe(lorebook === null || lorebook === undefined ? 2 : 0);
    expect(preview.findings.some((finding) => finding.level === 'unsupported')).toBe(false);
  }
);

test('module envelopes retain their explicit kind and malformed embedded sections never become inline fallbacks', () => {
  const module = sourceOf({ type: 'risuModule', module: { name: 'Module' } });
  expect(() => prepareRisuImport({ source: module, kind: 'bot' })).toThrow('RISU_IMPORT_KIND');
  expect(() => prepareRisuImport({ source: sourceOf(card()), kind: 'unknown' })).toThrow(
    'RISU_IMPORT_KIND'
  );
  const source = {
    name: 'bad.charx',
    base64: zip([
      ['card.json', Buffer.from(JSON.stringify(card()))],
      ['module.risum', Buffer.from([111, 0, 0, 0, 0, 0, 0])],
    ]).toString('base64'),
  };
  expect(() => prepareRisuImport({ source })).toThrow('RISU_IMPORT_INVALID_FILE');
});

test('module project ZIP reads ordered asset files within one project folder without RPack', async () => {
  const store = database();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNI293xHwAF3QKpuamA4gAAAABJRU5ErkJggg==',
    'base64'
  );
  const document = {
    type: 'risuModule',
    module: {
      name: 'Module project',
      description: 'Synthetic extracted project',
      lorebook: [{ comment: 'Picture', content: '{{image::green}}', alwaysActive: true }],
      assets: [['green', '', 'png']],
      regex: [],
      trigger: [],
    },
  };
  const moduleJson = Buffer.from(JSON.stringify(document));
  const marker = Buffer.from(
    JSON.stringify({
      version: 1,
      sourceFileType: 'risum',
      risumAssetFiles: ['.risutoki/risum-assets/custom.bin'],
    })
  );
  const bytes = zip([
    ['Project/module.json', moduleJson],
    ['Project/.risutoki/workspace.json', marker],
    ['Project/.risutoki/risum-assets/custom.bin', png],
  ]);
  const source = { name: 'module-project.zip', base64: bytes.toString('base64') };
  const preview = prepareRisuImport({ source });
  expect(preview).toMatchObject({
    kind: 'module',
    format: 'risu-module-project-zip',
    summary: { lore: 1, starts: 0, images: 1 },
  });
  expect(preview.findings.some((item) => item.level === 'unsupported')).toBe(false);
  const result = await applyRisuImport(store, {
    source,
    digest: preview.digest,
    allowPartial: false,
    idempotencyKey: 'module-project',
  });
  const content = store.product.stored<Content>('content', result.receipt.items[0].id);
  expect(content.package!.lore[0].text).toBe('{{image::green}}');
  expect(content.package!.nativeRisu!.assets).toEqual([
    expect.objectContaining({ name: 'green', imageId: 'image-0' }),
  ]);
  expect(content.package!.images).toHaveLength(1);
  expect(result.chat).toBeNull();

  const missing = {
    name: source.name,
    base64: zip([
      ['module.json', moduleJson],
      ['.risutoki/workspace.json', marker],
    ]).toString('base64'),
  };
  expect(prepareRisuImport({ source: missing }).findings).toContainEqual(
    expect.objectContaining({ code: 'asset-unavailable', level: 'unsupported' })
  );
});

test('module project refuses paths outside its folder and multiple module definitions', () => {
  const document = Buffer.from(
    JSON.stringify({
      type: 'risuModule',
      module: { name: 'Project', description: '', assets: [['image', '', 'png']] },
    })
  );
  const bytes = zip([
    ['module.json', document],
    [
      '.risutoki/workspace.json',
      Buffer.from(JSON.stringify({ risumAssetFiles: ['../outside.png'] })),
    ],
  ]);
  expect(() =>
    prepareRisuImport({ source: { name: 'project.zip', base64: bytes.toString('base64') } })
  ).toThrow('RISU_IMPORT_INVALID_FILE');
  const ambiguous = zip([
    ['one/module.json', document],
    ['two/module.json', document],
  ]);
  expect(() =>
    prepareRisuImport({ source: { name: 'projects.zip', base64: ambiguous.toString('base64') } })
  ).toThrow('RISU_IMPORT_INVALID_FILE');
});

test('charx keeps card-owned images while reading its embedded module; corrupt files never register', async () => {
  const store = database();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNI293xHwAF3QKpuamA4gAAAABJRU5ErkJggg==',
    'base64'
  );
  const value = card();
  Object.assign(value.data, {
    assets: [{ name: 'main', uri: 'embeded://assets/main.png', type: 'icon', ext: 'png' }],
    first_mes: '{{image::main}}',
  });
  const bytes = zip([
    ['card.json', Buffer.from(JSON.stringify(value))],
    ['assets/main.png', png],
    ['module.risum', writeEmbeddedRisuModule({ trigger: [{ type: 'unsupported-script' }] }, [])],
  ]);
  const source = { name: 'synthetic.charx', base64: bytes.toString('base64') };
  const preview = prepareRisuImport({ source });
  expect(preview.summary.images).toBe(1);
  const body = {
    source,
    digest: preview.digest,
    allowPartial: false,
    idempotencyKey: 'charx',
  };
  expect(store.db.prepare('SELECT count(*) AS n FROM chats').get()!.n).toBe(0);
  const result = await applyRisuImport(store, body);
  const pkg = store.product.stored<Content>('content', result.receipt.items[0].id).package!;
  expect(pkg.images).toHaveLength(1);
  expect(pkg.starts![0].text).toBe('{{image::main}}');
  expect(pkg.nativeRisu!.assets).toEqual([
    { name: 'main', uri: 'embeded://assets/main.png', imageId: 'image-0' },
  ]);
  expect(() =>
    prepareRisuImport({
      source: { name: 'bad.charx', base64: bytes.subarray(0, -5).toString('base64') },
    })
  ).toThrow('RISU_IMPORT_INVALID_FILE');
  expect(() => prepareRisuImport({ source: { name: 'bad.json', base64: 'eA==' } })).toThrow(
    'RISU_IMPORT_INVALID_FILE'
  );
});

test('a container beyond the inline limit is staged on disk, imported, and never copied into the receipt', async () => {
  const store = database();
  const app = Fastify();
  uploadRoutes(app, store.path);
  risuImportRoutes(app, store);
  try {
    const container = zip([
      ['card.json', Buffer.from(JSON.stringify(card()))],
      ['assets/first.bin', Buffer.alloc(25 * 1024 * 1024), 0],
      ['assets/second.bin', Buffer.alloc(40 * 1024 * 1024)],
    ]);
    expect(container.length).toBeGreaterThan(RISU_IMPORT_MAX_BYTES);
    const inline = await app.inject({
      method: 'POST',
      url: '/api/risu-imports/prepare',
      payload: { source: { name: 'huge.charx', base64: container.toString('base64') } },
    });
    expect(inline.statusCode).toBe(413);

    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { 'content-type': 'application/octet-stream' },
      payload: container,
    });
    expect(uploaded.statusCode).toBe(200);
    const { uploadId, bytes, sha256 } = uploaded.json();
    expect(bytes).toBe(container.length);
    expect(sha256).toBe(createHash('sha256').update(container).digest('hex'));
    expect(statSync(join(uploadDirectory(store.path), `${uploadId}.bin`)).size).toBe(bytes);

    const source = { name: 'huge.charx', uploadId };
    const prepared = await app.inject({
      method: 'POST',
      url: '/api/risu-imports/prepare',
      payload: { source },
    });
    expect(prepared.statusCode).toBe(200);
    const preview = prepared.json();
    expect(preview.title).toBe('Synthetic Pilot');

    const applied = await app.inject({
      method: 'POST',
      url: '/api/risu-imports/apply',
      payload: {
        source,
        digest: preview.digest,
        allowPartial: true,
        idempotencyKey: 'staged-import',
      },
    });
    expect(applied.statusCode).toBe(201);
    const receipt = applied.json().receipt;
    const content = store.product.stored<Content>('content', receipt.items[0].id);
    expect(content.title).toBe('Synthetic Pilot');
    expect(content.package!.nativeRisu!.sourceHash).toBe(sha256);

    expect(existsSync(join(uploadDirectory(store.path), `${uploadId}.bin`))).toBe(false);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/risu-imports/prepare',
          payload: { source },
        })
      ).statusCode
    ).toBe(404);
  } finally {
    await app.close();
  }
});

test('an oversized ZIP member is rejected even in a small compressed container', () => {
  const compressible = Buffer.alloc(70 * 1024 * 1024, 0);
  const bytes = Buffer.from(zip([['card.json', compressible]]));
  expect(bytes.length).toBeLessThan(1024 * 1024);
  expect(() => cardZip(bytes)).toThrow('RISU_IMPORT_INVALID_FILE');
});

const migratedEntry = () => ({
  name: 'Migrated',
  content: 'Migrated body.',
  keys: ['harbor'],
  secondary_keys: ['storm'],
  selective: true,
  insertion_order: 100,
  // https://github.com/kwaroran/RisuAI/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/characterCards.ts#L1073-L1078 (2026-11-20):
  // position 4 with numeric depth and role becomes `@@depth <depth>` and `@@role <[system, user, assistant][role]>`.
  extensions: { position: 4, depth: 3, role: 2, selectiveLogic: 1 },
  constant: false,
  enabled: true,
});

test('lore directives decide activation by exact-case name and never reach the model as prose', () => {
  const value = card();
  const entries = [
    {
      name: 'Engine data',
      content: '@@dont_activate\n{"boards":["news"]}',
      constant: true,
      enabled: true,
    },
    {
      name: 'Always on',
      content: '@@activate\n@@depth 3\n@@recursive\nThe harbor is busy.',
      constant: false,
      enabled: true,
    },
    { name: 'Plain', content: 'No directive here.', constant: true, enabled: true },
    {
      name: 'Upper directive',
      content: '@@ACTIVATE\n@@Depth 3\nThe market opens.',
      constant: false,
      enabled: true,
    },
    {
      name: 'Late directive',
      content: 'Opening line.\n@@depth 2\nMore text.',
      constant: true,
      enabled: true,
    },
    migratedEntry(),
  ];
  value.data.character_book.entries = entries;
  const preview = prepareRisuImport({
    source: {
      name: 'directives.json',
      base64: Buffer.from(JSON.stringify(value)).toString('base64'),
    },
  });
  const lore = Object.fromEntries(preview.lore.map((item) => [item.title, item]));
  expect(lore['Engine data']).toMatchObject({ enabled: false, text: '{"boards":["news"]}' });
  expect(lore['Always on']).toMatchObject({ enabled: true, loading: 'pinned' });
  expect(lore['Always on'].text).toBe('The harbor is busy.');
  expect(lore.Plain.text).toBe('No directive here.');
  expect(lore['Upper directive']).toMatchObject({ loading: 'discoverable' });
  expect(lore['Upper directive'].text).toBe('The market opens.');
  expect(lore['Late directive'].text).toBe('Opening line.\n@@depth 2\nMore text.');
  const converted = convertCharbook({
    lorebook: [],
    loresettings: undefined,
    loreExt: undefined,
    charbook: { extensions: {}, entries: [migratedEntry()] },
  }).lorebook[0].content.split('\n');
  expect(converted).toEqual([
    '@@exclude_keys_all storm',
    '@@depth 3',
    '@@role assistant',
    'Migrated body.',
  ]);
  expect(lore.Migrated.text).toBe(converted.at(-1));
  expect(lore.Migrated.keys).toBe('harbor');
  expect(lore.Plain.keys).toBeUndefined();
  expect(preview.findings).toEqual(
    expect.arrayContaining([
      { code: 'lore-not-activated', level: 'warning' },
      { code: 'lore-inline-directive', level: 'unsupported' },
      {
        code: 'lore-decorator-activation',
        level: 'info',
        params: { decorator: 'exclude_keys_all' },
      },
      { code: 'lore-decorator-activation', level: 'info', params: { decorator: 'recursive' } },
      {
        code: 'lore-decorator-unknown',
        level: 'unsupported',
        params: { names: '@@ACTIVATE, @@Depth', more: 0 },
      },
    ])
  );
  expect(preview.findings.filter((finding) => finding.code === 'lore-decorator-placement')).toEqual(
    []
  );
  expect(
    preview.findings.filter(
      (finding) =>
        finding.code === 'lore-decorator-activation' &&
        ['activate', 'dont_activate'].includes(finding.params.decorator)
    )
  ).toEqual([]);
});

const SURFACE_CODES = [
  'view-screen',
  'emotion-assets',
  'utility-bot',
  'card-license',
  'card-source',
  'image-generation',
  'depth-prompt',
  'card-metadata',
  'asset-role',
];

test('card metadata and typed assets remain in native source without conversion findings', async () => {
  const store = database();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNI293xHwAF3QKpuamA4gAAAABJRU5ErkJggg==',
    'base64'
  );
  const value = card();
  Object.assign(value.data, {
    creator_notes: 'Written by the card author.',
    tags: ['sci-fi'],
    creator: 'Author',
    character_version: '2',
    nickname: 'Pilot',
    assets: [
      { name: 'main', uri: 'embeded://assets/main.png', type: 'icon', ext: 'png' },
      { name: 'happy', uri: 'embeded://assets/happy.png', type: 'emotion', ext: 'png' },
    ],
    extensions: {
      depth_prompt: { prompt: 'Stay close.', depth: 4 },
      sd_prompt: 'a portrait',
      risuai: {
        viewScreen: 'emotion',
        inlayViewScreen: true,
        emotions: [['happy', '__asset:happy']],
        additionalAssets: [['extra', '__asset:extra', 'png']],
        utilityBot: true,
        license: 'CC0',
        source: ['https://example.invalid/card'],
        sdData: [['prompt', 'a portrait']],
      },
    },
  });
  const source = {
    name: 'surfaces.charx',
    base64: zip([
      ['card.json', Buffer.from(JSON.stringify(value))],
      ['assets/main.png', png],
      ['assets/happy.png', png],
    ]).toString('base64'),
  };
  const preview = prepareRisuImport({ source });
  const levels = Object.fromEntries(
    preview.findings.map((finding) => [finding.code, finding.level])
  );
  for (const code of SURFACE_CODES) expect(levels).not.toHaveProperty(code);
  expect(levels['extension-settings']).toBeUndefined();
  const saved = await applyRisuImport(store, {
    source,
    digest: preview.digest,
    allowPartial: true,
    idempotencyKey: 'surfaces',
  });
  const bot = store.product.stored<Content>('content', saved.receipt.items[0].id);
  expect(bot.description).toBe('Written by the card author.');
  expect(bot.package!.description).toBe('Written by the card author.');
  const expectedCard = structuredClone(value.data) as Record<string, any>;
  delete expectedCard.nickname;
  delete expectedCard.extensions.risuai.license;
  expect(bot.package!.nativeRisu!.card).toEqual(expectedCard);
  expect(bot.package!.images!.map((image) => image.title)).toEqual(['main', 'happy']);

  const plain = sourceOf(card());
  const plainPreview = prepareRisuImport({ source: plain });
  expect(plainPreview.findings).toEqual([]);
  const plainSaved = await applyRisuImport(store, {
    source: plain,
    digest: plainPreview.digest,
    allowPartial: false,
    idempotencyKey: 'plain-card',
  });
  expect(
    store.product.stored<Content>('content', plainSaved.receipt.items[0].id).description
  ).toContain('synthetic-card.json');
});

test('creator notes beyond the description limit are cut with an ellipsis and a notice', async () => {
  const store = database();
  const original = card();
  const source = sourceOf({
    ...original,
    data: { ...original.data, creator_notes: 'A'.repeat(4200) },
  });
  const preview = prepareRisuImport({ source });
  expect(preview.findings).toContainEqual(
    expect.objectContaining({ code: 'creator-notes-truncated', level: 'info' })
  );
  const saved = await applyRisuImport(store, {
    source,
    digest: preview.digest,
    allowPartial: false,
    idempotencyKey: 'long-notes',
  });
  const bot = store.product.stored<Content>('content', saved.receipt.items[0].id);
  expect(bot.description).toHaveLength(4000);
  expect(bot.description.endsWith('A…')).toBe(true);
  expect(bot.package!.description).toBe(bot.description);
});

test('a consumed staged upload retries through its small receipt before reading deleted bytes', async () => {
  const store = database();
  const app = Fastify();
  uploadRoutes(app, store.path);
  risuImportRoutes(app, store);
  try {
    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from(JSON.stringify(card())),
    });
    expect(uploaded.statusCode).toBe(200);
    const source = { name: 'synthetic.json', uploadId: uploaded.json().uploadId };
    const prepared = await app.inject({
      method: 'POST',
      url: '/api/risu-imports/prepare',
      payload: { source },
    });
    expect(prepared.statusCode).toBe(200);
    const payload = {
      source,
      digest: prepared.json().digest,
      allowPartial: false,
      idempotencyKey: 'lost-upload-response',
    };
    const first = await app.inject({ method: 'POST', url: '/api/risu-imports/apply', payload });
    expect(first.statusCode).toBe(201);
    expect(existsSync(join(uploadDirectory(store.path), `${source.uploadId}.bin`))).toBe(false);
    const retry = await app.inject({ method: 'POST', url: '/api/risu-imports/apply', payload });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().receipt.created).toBe(false);
    expect(retry.json().chat.id).toBe(first.json().chat.id);
    expect(store.chats()).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/risu-imports/apply',
          payload: { ...payload, digest: 'different-input' },
        })
      ).statusCode
    ).toBe(409);
  } finally {
    await app.close();
  }
});
