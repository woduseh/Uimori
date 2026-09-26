import { nativePrompt } from './fixtures/native-prompt.js';
import { afterEach, expect, test } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { crc32, deflateRawSync } from 'node:zlib';
import { Store } from '../server/store.js';
import { applyRisuImport, prepareRisuImport, risuImportRoutes } from '../server/risu-import.js';

import type { Content } from '../core/product.js';
import { nativeRisuRegex } from '../core/risu-native.js';
import { resolvePackageStart } from '../core/package-start.js';
import { compileContentAttachment } from '../core/package-runtime.js';
import { modelWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { decodeRPack } from '../server/compat/risu/rpack.js';
import { convertCharbook } from '../server/compat/risu/lorebook.js';
import { createHash } from 'node:crypto';
import { cardZip } from '../server/character-card-file.js';
import { uploadDirectory, uploadRoutes } from '../server/uploads.js';
import { RISU_IMPORT_MAX_BYTES } from '../core/risu-import.js';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

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

test.each(['{{original}}\nGive {{char}} room to act.', '{{original}}'])(
  'retired card fields are excluded while active global notes and source bytes remain: %s',
  async (globalNote) => {
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
    expect(preview.findings.map((finding) => finding.code)).toContain('native-risu');
    const saved = await applyRisuImport(store, {
      source,
      digest: preview.digest,
      allowPartial: false,
      idempotencyKey: 'guidance',
    });
    const content = store.product.get<Content>('content', saved.receipt.items[0].id),
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
  }
);

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
  const content = store.product.get<Content>('content', result.receipt.items[0].id),
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
  // Module lore is already in Risu's database shape, so these fields are the entry's own, not
  // extensions another frontend wrote.
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
            // Risu keeps `useRegex` only for a key written as a regex literal.
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
  const pkg = store.product.get<Content>('content', result.receipt.items[0].id).package!;
  expect(pkg.loreActivation).toEqual({ mode: 'model' });
  expect(pkg.nativeRisu.module!.lorebook).toMatchObject([
    { key: '/harbor/i', useRegex: true },
    { key: 'storm', secondkey: 'rain', selective: true, mode: 'child' },
  ]);
  expect(pkg.lore.every((item) => !Object.hasOwn(item, 'activation'))).toBe(true);
});

test('module scripts remain native source and module import cannot create memory', async () => {
  const store = database();
  const source = sourceOf({
    type: 'risuModule',
    module: {
      name: 'Scripted module',
      description: '',
      lorebook: [{ comment: 'Text', content: 'Lore', alwaysActive: true }],
      trigger: [
        { type: 'output', effect: [{ type: 'triggerlua', code: 'return "not executed"' }] },
      ],
      lowLevelAccess: true,
    },
  });
  const preview = prepareRisuImport({ source });
  expect(preview.findings.some((item) => item.code === 'native-risu')).toBe(true);
  const body = {
    source,
    digest: preview.digest,
    allowPartial: false,
    idempotencyKey: 'scripted-module',
  };
  const saved = await applyRisuImport(store, body);
  expect(
    store.product.get<Content>('content', saved.receipt.items[0].id).package!.nativeRisu!.module!
      .trigger
  ).toEqual([{ type: 'output', effect: [{ type: 'triggerlua', code: 'return "not executed"' }] }]);
  await expect(
    applyRisuImport(store, { ...body, allowPartial: true, memoryIds: ['lore-0'] })
  ).rejects.toThrow('Unknown request field');
  expect(store.db.prepare('SELECT count(*) AS n FROM chats').get()!.n).toBe(0);
  expect(() =>
    prepareRisuImport({
      source: sourceOf({ name: 'Unwrapped module', description: '', lorebook: [] }),
    })
  ).toThrow('RISU_IMPORT_INVALID_FILE');
});

test('card display regex stays native without creating a second transform program', async () => {
  const store = database();
  const value = card();
  Object.assign(value.data, {
    extensions: {
      risuai: {
        customScripts: [
          {
            type: 'editdisplay',
            in: '<state>([\\s\\S]*?)</state>',
            out: '**상태**$n$1',
            ableFlag: true,
            flag: 'g',
          },
        ],
      },
    },
  });
  const source = sourceOf(value),
    preview = prepareRisuImport({ source });
  expect(preview.findings.some((item) => item.level === 'unsupported')).toBe(false);
  expect(preview.findings).toContainEqual(expect.objectContaining({ code: 'native-risu' }));
  const saved = await applyRisuImport(store, {
    source,
    digest: preview.digest,
    allowPartial: false,
    idempotencyKey: 'display-regex',
  });
  const content = store.product.get<Content>('content', saved.receipt.items[0].id);
  expect(nativeRisuRegex(content.package!.nativeRisu!)).toEqual([
    {
      type: 'editdisplay',
      in: '<state>([\\s\\S]*?)</state>',
      out: '**상태**$n$1',
      ableFlag: true,
      flag: 'g',
    },
  ]);
});

test('imported opening identity tokens stay native until the opening runtime evaluates them', async () => {
  const store = database(),
    value = card();
  value.data.first_mes = '{{char}} welcomes {{user}}.';
  const source = sourceOf(value),
    preview = prepareRisuImport({ source });
  const saved = await applyRisuImport(store, {
    source,
    digest: preview.digest,
    allowPartial: false,
    idempotencyKey: 'opening-template',
  });
  const content = store.product.get<Content>('content', saved.receipt.items[0].id);
  expect(content.package!.starts![0].text).toBe(value.data.first_mes);
  expect(resolvePackageStart(content.package!, 'start-0').text).toBe('{{char}} welcomes {{user}}.');
  expect(saved.chat!.headRevision).not.toBeNull();
  expect(store.sourceOriginal(saved.chat!.headRevision!).text).toBe(value.data.first_mes);
});

test('card imports preserve all lore and cannot move it into the first chat notes', async () => {
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
    const bot = store.product.get<Content>('content', result.receipt.items[0].id);
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
    // Risu's decorator reader trims an entry's body, blank lines around it included.
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

// A compact standard ZIP fixture exercises the actual .charx reader, including deflate and CRC.
function zip(files: [string, Buffer][]) {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, bytes] of files) {
    const path = Buffer.from(name),
      compressed = deflateRawSync(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(path.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc32(bytes), 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(path.length, 28);
    directory.writeUInt32LE(offset, 42);
    locals.push(header, path, compressed);
    central.push(directory, path);
    offset += header.length + path.length + compressed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function embeddedModule(module: Record<string, unknown>) {
  const inverse = Buffer.alloc(256);
  for (const [encoded, plain] of decodeRPack(
    Buffer.from(Array.from({ length: 256 }, (_, i) => i))
  ).entries())
    inverse[plain] = encoded;
  const bytes = Buffer.from(JSON.stringify({ type: 'risuModule', module }));
  const header = Buffer.from([111, 0, 0, 0, 0, 0]);
  header.writeUInt32LE(bytes.length, 2);
  return Buffer.concat([
    header,
    Buffer.from(bytes.map((value) => inverse[value])),
    Buffer.from([0]),
  ]);
}

test.each([undefined, null, []])(
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
        ['module.risum', embeddedModule({ lorebook })],
      ]).toString('base64'),
    };
    const preview = prepareRisuImport({ source });
    expect(preview.summary.lore).toBe(lorebook === null || lorebook === undefined ? 2 : 0);
    expect(
      preview.findings.some(
        (finding) => finding.code === 'display-regex' || finding.level === 'unsupported'
      )
    ).toBe(false);
  }
);

test('module envelopes retain their explicit kind and malformed embedded sections never become inline fallbacks', () => {
  const module = sourceOf({ type: 'risuModule', module: { name: 'Module' } });
  expect(() => prepareRisuImport({ source: module, kind: 'bot' })).toThrow('RISU_IMPORT_KIND');
  expect(() => prepareRisuImport({ source: sourceOf(card()), kind: 'unknown' })).toThrow(
    'RISU_IMPORT_KIND'
  );
  const store = database(),
    source = {
      name: 'bad.charx',
      base64: zip([
        ['card.json', Buffer.from(JSON.stringify(card()))],
        ['module.risum', Buffer.from([111, 0, 0, 0, 0, 0, 0])],
      ]).toString('base64'),
    };
  expect(() => prepareRisuImport({ source })).toThrow('RISU_IMPORT_INVALID_FILE');
  expect(store.db.prepare('SELECT count(*) AS n FROM chats').get()!.n).toBe(0);
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
  const content = store.product.get<Content>('content', result.receipt.items[0].id);
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
    ['module.risum', embeddedModule({ trigger: [{ type: 'unsupported-script' }] })],
  ]);
  const source = { name: 'synthetic.charx', base64: bytes.toString('base64') };
  const preview = prepareRisuImport({ source });
  expect(preview.summary.images).toBe(1);
  expect(preview.findings).toContainEqual(
    expect.objectContaining({ code: 'native-risu', level: 'info' })
  );
  const body = {
    source,
    digest: preview.digest,
    allowPartial: false,
    idempotencyKey: 'charx',
  };
  expect(store.db.prepare('SELECT count(*) AS n FROM chats').get()!.n).toBe(0);
  const result = await applyRisuImport(store, body);
  const pkg = store.product.get<Content>('content', result.receipt.items[0].id).package!;
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
    // Incompressible filler makes the staged container exceed the inline request limit, and its
    // uncompressed contents pass the old fixed expansion cap only because the container is large.
    const container = Buffer.from(
      zip([
        ['card.json', Buffer.from(JSON.stringify(card()))],
        ['assets/first.bin', randomBytes(40 * 1024 * 1024)],
        ['assets/second.bin', randomBytes(30 * 1024 * 1024)],
      ])
    );
    expect(container.length).toBeGreaterThan(RISU_IMPORT_MAX_BYTES);
    const inline = await app.inject({
      method: 'POST',
      url: '/api/risu-imports/prepare',
      payload: { source: { name: 'huge.charx', base64: container.toString('base64') } },
    });
    // The inline route refuses it before any parse; the staged route is the only way in.
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
    expect(readFileSync(join(uploadDirectory(store.path), `${uploadId}.bin`)).length).toBe(bytes);

    const source = { name: 'huge.charx', uploadId };
    const prepared = await app.inject({
      method: 'POST',
      url: '/api/risu-imports/prepare',
      payload: { source },
    });
    expect(prepared.statusCode).toBe(200);
    const preview = prepared.json();
    expect(preview.title).toBe('Synthetic Pilot');
    const notRetained = preview.findings.find(
      (finding: { code: string }) => finding.code === 'source-file-not-retained'
    );
    expect(notRetained.level).toBe('warning');
    expect(notRetained.message).toContain(sha256);

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
    const content = store.product.get<Content>('content', receipt.items[0].id);
    expect(content.title).toBe('Synthetic Pilot');
    // The registered material carries no copy of the original container.

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

test('a comment in card text stays in native source without a converted template', async () => {
  const store = database(),
    original = card();
  const source = sourceOf({
    ...original,
    data: { ...original.data, description: '{{// hidden}}{{char}} reads {{getvar::flag}}.' },
  });
  const preview = prepareRisuImport({ source });
  expect(preview.findings.map((item) => item.code)).not.toContain('compat-evaluation');
  const saved = await applyRisuImport(store, {
    source,
    digest: preview.digest,
    allowPartial: false,
    idempotencyKey: 'comment',
  });
  const bot = store.product.get<Content>('content', saved.receipt.items[0].id);
  expect(bot.package!.body).toBe('{{// hidden}}{{char}} reads {{getvar::flag}}.');
  expect(bot.package!.nativeRisu!.card.description).toBe(bot.package!.body);
});

// An entry another frontend wrote as CCv3 `extensions`, which Risu migrates into `@@` lines on import.
const migratedEntry = () => ({
  name: 'Migrated',
  content: 'Migrated body.',
  keys: ['harbor'],
  secondary_keys: ['storm'],
  selective: true,
  insertion_order: 100,
  // Risu reads position 4 as "at depth" and the role as an index into system/user/assistant.
  extensions: { position: 4, depth: 3, role: 2, selectiveLogic: 1 },
  constant: false,
  enabled: true,
});

test('lore directives decide activation and never reach the model as prose', () => {
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
  // The material's own data stays out of the imported prompt material.
  expect(lore['Engine data']).toMatchObject({ enabled: false, text: '{"boards":["news"]}' });
  expect(lore['Always on']).toMatchObject({ enabled: true, loading: 'pinned' });
  expect(lore['Always on'].text).toBe('The harbor is busy.');
  expect(lore.Plain.text).toBe('No directive here.');
  // Risu's decorator names are case-sensitive, so an uppercase line is a decorator it does not know:
  // the line leaves the body without deciding anything.
  expect(lore['Upper directive']).toMatchObject({ loading: 'discoverable' });
  expect(lore['Upper directive'].text).toBe('The market opens.');
  expect(lore['Late directive'].text).toBe('Opening line.\n@@depth 2\nMore text.');
  // The body and the `@@` lines are the ones Risu's own conversion produces for the same entry.
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
  // The keys travel with the entry so the import screen can say what turns it on.
  expect(lore.Migrated.keys).toBe('harbor');
  expect(lore.Plain.keys).toBeUndefined();
  const levels = Object.fromEntries(
    preview.findings.map((finding) => [finding.code, finding.level])
  );
  expect(levels['lore-not-activated']).toBe('warning');
  // The keyword rules are carried now, so neither notice about dropping them is raised any more.
  expect(levels['native-lore-model']).toBe('info');
  expect(levels).not.toHaveProperty('lore-discovery');
  expect(levels).not.toHaveProperty('lore-rules');
  expect(levels['lore-decorator-position']).toBe('unsupported');
  // One finding per decorator the lorebook carries, instead of one aggregate notice for all of them.
  expect(levels).not.toHaveProperty('lore-decorators');
  // Native depth/role placement and supported activation decorators no longer carry loss findings.
  expect(levels).not.toHaveProperty('lore-decorator:depth');
  expect(levels).not.toHaveProperty('lore-decorator:role');
  expect(levels['lore-decorator:exclude_keys_all']).toBe('info');
  expect(levels['lore-decorator:recursive']).toBe('info');
  expect(levels).not.toHaveProperty('lore-decorator:activate');
  expect(levels).not.toHaveProperty('lore-decorator:dont_activate');
  const unknown = preview.findings.find((finding) => finding.code === 'lore-decorator-unknown');
  expect(unknown?.level).toBe('unsupported');
  expect(unknown?.message).toContain('@@ACTIVATE');
  expect(unknown?.message).toContain('@@Depth');
});

test('a lorebook without directives reports nothing about decorators', () => {
  const preview = prepareRisuImport({ source: sourceOf(card()) });
  expect(preview.findings.filter((finding) => finding.code.startsWith('lore-decorator'))).toEqual(
    []
  );
});

// Every surface the card carries and the import does not reproduce has to reach the reader.
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
  expect(levels['native-risu']).toBe('info');
  // The settings that now have their own notice no longer fall into the generic bucket.
  expect(levels['extension-settings']).toBeUndefined();
  const saved = await applyRisuImport(store, {
    source,
    digest: preview.digest,
    allowPartial: true,
    idempotencyKey: 'surfaces',
  });
  const bot = store.product.get<Content>('content', saved.receipt.items[0].id);
  expect(bot.description).toBe('Written by the card author.');
  expect(bot.package!.description).toBe('Written by the card author.');
  const expectedCard = structuredClone(value.data) as Record<string, any>;
  delete expectedCard.nickname;
  delete expectedCard.extensions.risuai.license;
  expect(bot.package!.nativeRisu!.card).toEqual(expectedCard);
  // Image projections link storage; the source keeps their authored roles and extension fields.
  expect(bot.package!.images!.map((image) => image.title)).toEqual(['main', 'happy']);

  const plain = sourceOf(card());
  const plainPreview = prepareRisuImport({ source: plain });
  const plainCodes = plainPreview.findings.map((finding) => finding.code);
  for (const code of [...SURFACE_CODES, 'creator-notes-truncated'])
    expect(plainCodes).not.toContain(code);
  expect(plainPreview.findings.filter((finding) => finding.level === 'unsupported')).toEqual([]);
  const plainSaved = await applyRisuImport(store, {
    source: plain,
    digest: plainPreview.digest,
    allowPartial: false,
    idempotencyKey: 'plain-card',
  });
  // A card without creator notes keeps the generated line naming the file it came from.
  expect(
    store.product.get<Content>('content', plainSaved.receipt.items[0].id).description
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
  const bot = store.product.get<Content>('content', saved.receipt.items[0].id);
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
