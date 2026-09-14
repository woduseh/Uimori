import { afterEach, expect, test } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { crc32, deflateRawSync } from 'node:zlib';
import { Store } from '../server/store.js';
import { applyRisuImport, prepareRisuImport, risuImportRoutes } from '../server/risu-import.js';
import { nativeTransferOriginal } from '../server/native-transfer.js';
import type { Content } from '../core/product.js';
import { applyPackageTransforms } from '../server/package-transforms.js';
import { resolvePackageStart } from '../core/package-start.js';
import { createPackageStart } from '../server/package-start.js';
import { compilePackageAttachment } from '../core/package-runtime.js';
import { modelWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { decodeRPack } from '../server/rpack.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { buildPackagePresentation } from '../server/package-presentation.js';
import { createHash } from 'node:crypto';
import { importRisuPresetProgram } from '../server/risu-preset-program.js';
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

test('imported bot and preset defaults share one read context with module lore and frozen openings', () => {
  const store = database();
  const preset = importRisuPresetProgram({
    name: 'Variable preset',
    templateDefaultVariables: 'shared=PRESET\nfallback=FALLBACK',
    promptTemplate: [
      { type: 'plain', role: 'system', text: 'PRESET:{{getvar::shared}}/{{getvar::fallback}}' },
      { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
    ],
  });
  updatePromptWorkspace(store, {
    expectedRevision: modelWorkspace(store).revision,
    main: {
      title: preset.title,
      program: preset.program,
      values: {},
    },
  });
  const original = card();
  const source = sourceOf({
    ...original,
    data: {
      ...original.data,
      description: 'BODY:{{getvar::shared}}',
      first_mes: 'OPEN:{{getvar::shared}}/{{getvar::fallback}}',
      post_history_instructions: '{{#when::var::flag}}GUIDANCE:{{getvar::shared}}{{/when}}',
      extensions: { risuai: { defaultVariables: 'shared=BOT\nshared=IGNORED\nflag=true' } },
    },
  });
  const before = store.product.export();
  const preview = prepareRisuImport({ source });
  expect(store.product.export().tables).toEqual(before.tables);
  expect(preview.findings.filter((item) => item.level === 'unsupported')).toEqual([]);
  const saved = applyRisuImport(store, {
    source,
    digest: preview.digest,
    memoryIds: [],
    allowPartial: false,
    idempotencyKey: 'variables',
  });
  const bot = store.product.get<Content>('content', saved.receipt.items[0].id);
  expect(bot.package!.variableDefaults).toEqual({
    values: { shared: 'BOT', flag: 'true' },
    attachmentRoles: ['bot'],
  });
  expect(bot.package!.behavior).toBeUndefined();
  const moduleSource = sourceOf({
    ...original,
    data: {
      ...original.data,
      name: 'Variable reader module',
      description: '',
      first_mes: '',
      alternate_greetings: [],
      extensions: { risuai: { defaultVariables: 'shared=MODULE_IGNORED' } },
      character_book: {
        entries: [
          {
            name: 'Reader',
            content: 'MODULE:{{getvar::shared}}/{{getvar::fallback}}',
            constant: true,
          },
        ],
      },
    },
  });
  const modulePreview = prepareRisuImport({ source: moduleSource, kind: 'module' });
  const importedModule = applyRisuImport(store, {
    source: moduleSource,
    kind: 'module',
    digest: modulePreview.digest,
    memoryIds: [],
    allowPartial: false,
    idempotencyKey: 'reader-module',
  });
  const module = store.product.get<Content>('content', importedModule.receipt.items[0].id);
  const chat = saved.chat!,
    profile = store.product.profile(chat.id);
  store.product.updateProfile(chat.id, {
    expectedRevision: profile.revision,
    attachments: [],
    image: false,
    packageAttachments: [
      ...profile.packageAttachments!,
      { id: module.id, revision: module.revision, role: 'module' },
    ],
  });
  const frozen = store.product.snapshot(chat.id)!;
  const snapshot = compileSnapshotPrompt({
    chatId: chat.id,
    parentRevision: null,
    settingsRevision: chat.settingsRevision,
    settings: chat.settings,
    request: 'Continue.',
    history: [],
    logicalHistory: [],
    profile: frozen,
    resources: store.product.resources(chat.id, frozen),
  });
  const input = JSON.stringify(snapshot.promptCompilation!.messages);
  for (const expected of ['BODY:BOT', 'PRESET:BOT/FALLBACK', 'MODULE:BOT/FALLBACK', 'GUIDANCE:BOT'])
    expect(input).toContain(expected);
  expect(input).not.toContain('MODULE_IGNORED');
  const opened = createPackageStart(store, chat.id, {
    packageId: bot.id,
    packageRevision: bot.revision,
    startId: 'start-0',
    expectedSettingsRevision: chat.settingsRevision,
    expectedProfileRevision: frozen.revision,
    idempotencyKey: 'variables-opening',
  });
  expect(store.sourceOriginal(opened.run.sourceRevision!).text).toBe('OPEN:BOT/FALLBACK');
  store.product.content(
    {
      kind: bot.kind,
      title: bot.title,
      description: bot.description,
      text: bot.text,
      loading: bot.loading,
      relatedIds: [],
      expectedRevision: bot.revision,
      package: {
        ...bot.package!,
        variableDefaults: { values: { shared: 'CHANGED', flag: 'true' }, attachmentRoles: ['bot'] },
      },
    },
    bot.id
  );
  expect(JSON.stringify(compileSnapshotPrompt(snapshot).promptCompilation!.messages)).toBe(input);
  expect(nativeTransferOriginal(store, saved.receipt.id).sourceFiles![0].base64).toBe(
    source.base64
  );
  const restored = database();
  expect(() => restored.product.import(store.product.export())).not.toThrow();
  expect(restored.sourceOriginal(opened.run.sourceRevision!).text).toBe('OPEN:BOT/FALLBACK');
});

test.each(['{{original}}\nGive {{char}} room to act.', '{{original}}'])(
  'card guidance supplements the selected prompt; excluded legacy fields stay only in source: %s',
  (globalNote) => {
    const store = database();
    const workspace = modelWorkspace(store);
    updatePromptWorkspace(store, {
      expectedRevision: workspace.revision,
      main: {
        title: 'Selected prompt',
        program: {
          version: 1,
          controls: [],
          blocks: [
            {
              id: 'main',
              title: 'Main',
              kind: 'message',
              role: 'system',
              template: [{ kind: 'text', text: 'KEEP_SELECTED_MAIN' }],
            },
            { id: 'current', title: 'Input', kind: 'current' },
          ],
        },
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
    expect(preview.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        'legacy-character-fields',
        'main-prompt-override',
        'global-note-as-guidance',
      ])
    );
    const saved = applyRisuImport(store, {
      source,
      digest: preview.digest,
      memoryIds: [],
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
    expect(delivered).not.toMatch(/EXCLUDED_|\{\{original\}\}/u);
    if (globalNote.includes('Give')) {
      expect(delivered).toContain('Give Synthetic Pilot room to act.');
      expect(content.package!.instructions[0]).toMatchObject({
        id: 'writing-guidance',
        target: 'main',
      });
    } else expect(content.package!.instructions).toEqual([]);
    expect(modelWorkspace(store)).toEqual(before);
    expect(nativeTransferOriginal(store, saved.receipt.id).sourceFiles![0].base64).toBe(
      source.base64
    );
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
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
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
    memoryIds: [],
    allowPartial: false,
    idempotencyKey: 'module-json',
  };
  const result = applyRisuImport(store, body);
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
  const compiled = compilePackageAttachment(
    pkg,
    { id: pkg.id, revision: pkg.revision, role: 'module' },
    {
      chatId: 'synthetic',
      target: 'main',
      identity: { bot: { name: 'Pilot' }, user: { name: 'Mira' } },
    }
  );
  expect(compiled.resources.find((item) => item.id.endsWith(':lore:lore-0'))?.text).toBe(
    'Mira visits a green moon.'
  );
  expect(
    (await applyPackageTransforms('<status>ready</status>', pkg.transforms, 'source')).text
  ).toBe('**ready**');
  expect(nativeTransferOriginal(store, result.receipt.id).sourceFiles![0].base64).toBe(
    source.base64
  );
  expect(applyRisuImport(store, body).receipt).toMatchObject({
    id: result.receipt.id,
    created: false,
  });
});

test('module scripts remain explicit unsupported findings and module import cannot create memory', () => {
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
  expect(preview.findings.some((item) => item.level === 'unsupported')).toBe(true);
  const body = {
    source,
    digest: preview.digest,
    memoryIds: [],
    allowPartial: false,
    idempotencyKey: 'scripted-module',
  };
  expect(() => applyRisuImport(store, body)).toThrow('RISU_IMPORT_PARTIAL_REQUIRED');
  expect(() =>
    applyRisuImport(store, { ...body, allowPartial: true, memoryIds: ['lore-0'] })
  ).toThrow('RISU_IMPORT_MEMORY_SELECTION');
  expect(store.db.prepare('SELECT count(*) AS n FROM chats').get()!.n).toBe(0);
  expect(() =>
    prepareRisuImport({
      source: sourceOf({ name: 'Unwrapped module', description: '', lorebook: [] }),
    })
  ).toThrow('RISU_IMPORT_INVALID_FILE');
});

test('card display regex is imported through the shared package renderer', async () => {
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
  expect(preview.findings).toContainEqual(expect.objectContaining({ code: 'display-regex' }));
  const saved = applyRisuImport(store, {
    source,
    digest: preview.digest,
    memoryIds: [],
    allowPartial: false,
    idempotencyKey: 'display-regex',
  });
  const content = store.product.get<Content>('content', saved.receipt.items[0].id);
  expect(content.package!.transforms).toHaveLength(1);
  expect(
    (await applyPackageTransforms('<state>HP 3</state>', content.package!.transforms, 'source'))
      .text
  ).toBe('**상태**\nHP 3');
  expect(nativeTransferOriginal(store, saved.receipt.id).sourceFiles![0].base64).toBe(
    source.base64
  );
});

test('imported opening identity tokens become native templates while source bytes stay intact', () => {
  const store = database(),
    value = card();
  value.data.first_mes = '{{char}} welcomes {{user}}.';
  const source = sourceOf(value),
    preview = prepareRisuImport({ source });
  const saved = applyRisuImport(store, {
    source,
    digest: preview.digest,
    memoryIds: [],
    allowPartial: false,
    idempotencyKey: 'opening-template',
  });
  const content = store.product.get<Content>('content', saved.receipt.items[0].id);
  expect(content.package!.starts![0].text).toBe(value.data.first_mes);
  expect(
    resolvePackageStart(
      content.package!,
      'start-0',
      {},
      { bot: { name: 'Pilot' }, user: { name: '{{user}}' } }
    ).text
  ).toBe('Pilot welcomes {{user}}.');
  const opened = createPackageStart(store, saved.chat!.id, {
    packageId: content.id,
    packageRevision: content.revision,
    startId: 'start-0',
    expectedSettingsRevision: saved.chat!.settingsRevision,
    expectedProfileRevision: store.product.profile(saved.chat!.id).revision,
    idempotencyKey: 'open',
  });
  expect(store.sourceOriginal(opened.run.sourceRevision!).text).toBe(
    'Synthetic Pilot welcomes User.'
  );
  expect(nativeTransferOriginal(store, saved.receipt.id).sourceFiles![0].base64).toBe(
    source.base64
  );
});

test('card routes import a usable bot and chat; memory separation is opt-in, exact and idempotent', async () => {
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
    expect(preview.lore.every((item: { memoryCandidate: boolean }) => !item.memoryCandidate)).toBe(
      true
    );
    expect(store.db.prepare('SELECT count(*) AS n FROM chats').get()!.n).toBe(0);
    const body = {
      source,
      digest: preview.digest,
      memoryIds: [],
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
      'Synthetic Pilot explores an imaginary planet.'
    );
    expect(resources.find((item) => item.id.endsWith(':lore:lore-1'))?.text).toBe(
      '\nEarlier travel with User.\n'
    );
    expect(store.story.notes.revision(result.chat.id)).toBe(0);
    expect(JSON.stringify(bot)).not.toContain(source.base64);
    const selectedBody = { ...body, idempotencyKey: 'with-memory', memoryIds: ['lore-1'] };
    const selected = applyRisuImport(store, selectedBody);
    expect(
      store.product.get<Content>('content', selected.receipt.items[0].id).package!.lore
    ).toHaveLength(1);
    const notes = store.story.notes.entries(store.story.notes.scope(selected.chat!.id, null));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      kind: 'imported-memory',
      text: '\nEarlier travel with {{user}}.\n',
      atRevision: null,
      atHash: null,
      origin: { entryId: 'lore-1', title: 'History' },
    });
    expect(
      store.db.prepare('SELECT count(*) AS n FROM sources WHERE chat_id=?').get(selected.chat!.id)!
        .n
    ).toBe(0);
    expect(nativeTransferOriginal(store, selected.receipt.id).sourceFiles![0].base64).toBe(
      source.base64
    );
    expect(applyRisuImport(store, selectedBody)).toMatchObject({
      receipt: { id: selected.receipt.id, created: false },
      chat: { id: selected.chat!.id },
    });
    expect(() => applyRisuImport(store, { ...selectedBody, memoryIds: [] })).toThrow(
      'NATIVE_TRANSFER_IMPORT_CONFLICT'
    );
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

test('one CharX imports as a module, attaches to a bot, and uses canonical lore and display without duplication', async () => {
  const store = database(),
    value = card();
  Object.assign(value.data, {
    creator_notes: 'Module information',
    extensions: {
      risuai: {
        customScripts: [{ type: 'editdisplay', in: 'SOURCE', out: 'WRONG INLINE' }],
        triggerscript: [{ unexpected: 'inline trigger' }],
      },
    },
  });
  const source = {
    name: 'neutral.charx',
    base64: zip([
      ['card.json', Buffer.from(JSON.stringify(value))],
      [
        'module.risum',
        embeddedModule({
          name: 'Not the card title',
          description: 'Not the card creator notes',
          lorebook: [
            {
              comment: 'Canonical lore',
              content: 'UNIQUE_EMBEDDED_LORE {{char}}',
              alwaysActive: true,
              insertorder: 41,
            },
          ],
          regex: [{ type: 'editdisplay', in: 'SOURCE', out: 'DISPLAY', ableFlag: true, flag: 'g' }],
          trigger: [],
        }),
      ],
    ]).toString('base64'),
  };
  const preview = prepareRisuImport({ source, kind: 'module' }),
    asBot = prepareRisuImport({ source, kind: 'bot' });
  expect(preview).toMatchObject({
    kind: 'module',
    title: value.data.name,
    description: 'Module information',
    summary: { lore: 1, starts: 2, images: 0 },
  });
  expect(preview.findings.some((item) => item.level === 'unsupported')).toBe(false);
  expect(preview.digest).not.toBe(asBot.digest);
  const body = {
    source,
    kind: 'module' as const,
    digest: preview.digest,
    memoryIds: [],
    allowPartial: false,
    idempotencyKey: 'canonical-module',
  };
  expect(() => applyRisuImport(store, { ...body, kind: 'bot' })).toThrow(
    'RISU_IMPORT_DRAFT_CHANGED'
  );
  const saved = applyRisuImport(store, body);
  expect(saved.chat).toBeNull();
  expect(store.db.prepare('SELECT count(*) AS n FROM chats').get()!.n).toBe(0);
  const content = store.product.get<Content>('content', saved.receipt.items[0].id);
  expect(content.package!.lore.map((lore) => lore.text)).toEqual(['UNIQUE_EMBEDDED_LORE {{char}}']);
  expect(content.package!.lore[0].loreContext?.order).toBe(41);
  expect(content.package!.identity).toBeUndefined();
  const input = fixtureBotInput('Host Bot');
  input.package.modules = [{ id: content.id, revision: content.revision }];
  const bot = store.product.content(input) as Content;
  const chat = store.createChat('Using imported module', undefined, { botId: bot.id });
  const profile = store.product.snapshot(chat.id)!;
  const snapshot = compileSnapshotPrompt({
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
  const messages = JSON.stringify(snapshot.promptCompilation!.messages);
  expect(messages.match(/UNIQUE_EMBEDDED_LORE/gu)).toHaveLength(1);
  expect(messages).not.toContain('The sky is green.');
  const display = await buildPackagePresentation(snapshot, {
    id: 'source',
    chatId: chat.id,
    text: 'SOURCE',
    hash: createHash('sha256').update('SOURCE').digest('hex'),
  });
  expect(display.original.text).toBe('DISPLAY');
  const original = nativeTransferOriginal(store, saved.receipt.id);
  expect(original.sourceFiles).toHaveLength(1);
  expect(original.sourceFiles![0].base64).toBe(source.base64);
  expect(applyRisuImport(store, body).receipt).toMatchObject({
    id: saved.receipt.id,
    created: false,
  });
  const restored = database();
  restored.product.import(store.product.export());
  expect(nativeTransferOriginal(restored, saved.receipt.id).sourceFiles![0].base64).toBe(
    source.base64
  );
});

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

test('module project ZIP reads ordered asset files within one project folder without RPack', () => {
  const store = database();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
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
  const result = applyRisuImport(store, {
    source,
    digest: preview.digest,
    memoryIds: [],
    allowPartial: false,
    idempotencyKey: 'module-project',
  });
  const content = store.product.get<Content>('content', result.receipt.items[0].id);
  expect(content.package!.lore[0].text).toMatch(/^!\[green\]\(\/api\/package-image-blobs\//u);
  expect(content.package!.images).toHaveLength(1);
  expect(result.chat).toBeNull();
  expect(nativeTransferOriginal(store, result.receipt.id).sourceFiles![0]).toMatchObject({
    mediaType: 'application/zip',
    base64: source.base64,
  });
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

test('charx keeps card-owned images while reading its embedded module; corrupt files never register', () => {
  const store = database();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
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
    expect.objectContaining({ code: 'embedded-module', level: 'info' })
  );
  const body = {
    source,
    digest: preview.digest,
    memoryIds: [],
    allowPartial: false,
    idempotencyKey: 'charx',
  };
  expect(() => applyRisuImport(store, body)).toThrow('RISU_IMPORT_PARTIAL_REQUIRED');
  expect(store.db.prepare('SELECT count(*) AS n FROM chats').get()!.n).toBe(0);
  const result = applyRisuImport(store, { ...body, allowPartial: true });
  const pkg = store.product.get<Content>('content', result.receipt.items[0].id).package!;
  expect(pkg.images).toHaveLength(1);
  expect(pkg.starts![0].text).toMatch(/^!\[main\]\(\/api\/package-image-blobs\//u);
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
        memoryIds: [],
        allowPartial: true,
        idempotencyKey: 'staged-import',
      },
    });
    expect(applied.statusCode).toBe(201);
    const receipt = applied.json().receipt;
    const content = store.product.get<Content>('content', receipt.items[0].id);
    expect(content.title).toBe('Synthetic Pilot');
    // The registered material carries no copy of the original container.
    expect(nativeTransferOriginal(store, receipt.id).sourceFiles).toBeUndefined();
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

test('an expansion bomb and an oversized member stay refused whatever the container size', () => {
  const compressible = Buffer.alloc(70 * 1024 * 1024, 0);
  // A small container that declares far more than its own size is still an expansion bomb.
  const bomb = Buffer.from(zip([['card.json', compressible]]));
  expect(bomb.length).toBeLessThan(1024 * 1024);
  expect(() => cardZip(bomb)).toThrow('RISU_IMPORT_INVALID_FILE');
  // A large container cannot smuggle one member past the per-member cap either.
  const oversized = Buffer.from(
    zip([
      ['card.json', Buffer.from('{}')],
      ['assets/one.bin', compressible],
    ])
  );
  expect(() => cardZip(oversized)).toThrow('RISU_IMPORT_INVALID_FILE');
});

test('the unhandled trigger notice follows only what the adapter left unconnected', () => {
  const codes = (triggerscript: unknown) => {
    const original = card();
    return prepareRisuImport({
      source: sourceOf({
        ...original,
        data: { ...original.data, extensions: { risuai: { triggerscript } } },
      }),
    }).findings.map((item) => item.code);
  };
  const connected = {
    type: 'start',
    conditions: [],
    effect: [{ type: 'setvar', operator: '=', var: 'phase', value: 'ready' }],
  };
  expect(codes([connected])).not.toContain('trigger-effects-unsupported');
  expect(codes([{ ...connected, effect: [{ type: 'cutchat', start: '0', end: '1' }] }])).toContain(
    'trigger-effects-unsupported'
  );
  expect(codes([{ ...connected, type: 'display' }])).toContain('trigger-effects-unsupported');
  expect(codes([null])).toContain('trigger-effects-unsupported');
  expect(codes('one inline trigger')).toContain('trigger-effects-unsupported');
});

test('a comment in card text keeps the whole field converted instead of names only', () => {
  const store = database(),
    original = card();
  const source = sourceOf({
    ...original,
    data: { ...original.data, description: '{{// hidden}}{{char}} reads {{getvar::flag}}.' },
  });
  const preview = prepareRisuImport({ source });
  expect(preview.findings.map((item) => item.code)).not.toContain('dynamic-text');
  const saved = applyRisuImport(store, {
    source,
    digest: preview.digest,
    memoryIds: [],
    allowPartial: false,
    idempotencyKey: 'comment',
  });
  const bot = store.product.get<Content>('content', saved.receipt.items[0].id);
  expect(JSON.stringify(bot.package!.bodyTemplate)).not.toContain('{{');
});

test('lore directives decide activation and never reach the model as prose', () => {
  const value = card();
  value.data.character_book.entries = [
    {
      name: 'Engine data',
      content: '@@dont_activate\n{"boards":["news"]}',
      constant: true,
      enabled: true,
    },
    {
      name: 'Always on',
      content: '@@activate\n@@depth 3\nThe harbor is busy.',
      constant: false,
      enabled: true,
    },
    { name: 'Plain', content: 'No directive here.', constant: true, enabled: true },
    {
      name: 'Upper directive',
      content: '@@ACTIVATE\nThe market opens.',
      constant: false,
      enabled: true,
    },
    {
      name: 'Late directive',
      content: 'Opening line.\n@@depth 2\nMore text.',
      constant: true,
      enabled: true,
    },
  ];
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
  // Risu compares decorator names with lowercase labels, so an uppercase line stays prose.
  expect(lore['Upper directive']).toMatchObject({ loading: 'discoverable' });
  expect(lore['Upper directive'].text).toBe('@@ACTIVATE\nThe market opens.');
  expect(lore['Late directive'].text).toBe('Opening line.\n@@depth 2\nMore text.');
  const codes = preview.findings.map((finding) => finding.code);
  expect(codes).toContain('lore-not-activated');
  expect(codes).toContain('lore-decorators');
  expect(codes).toContain('lore-decorator-position');
});
