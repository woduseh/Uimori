import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { createApp, type App } from '../server/app.js';
import { Store } from '../server/store.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { nativeDraftTitle } from './fixtures/native-content.js';
import { saveResource } from '../server/resource-service.js';
import { editableResource } from '../core/resource-editing.js';
import { imageJobInput } from '../server/package-images.js';
import { imageJudgmentRequest } from '../server/image-judgment.js';
import { processImage } from '../server/image-processing.js';
import { readImage, storeImage } from '../server/image-storage.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import { forkChat } from '../server/chat-fork.js';
import { databaseBackupStream } from '../server/database-backup.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import * as transport from '../core/transport.js';
import type { Content } from '../core/product.js';

const owned: { path: string; app?: App; store?: Store }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0)) {
    await item.app?.close();
    item.store?.close();
    rmSync(item.path, { recursive: true, force: true });
  }
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-v1-flow-'));
  const owner = { path } as (typeof owned)[number];
  owned.push(owner);
  return owner;
}
function database() {
  const owner = directory();
  owner.store = new Store(join(owner.path, 'app.sqlite'));
  return owner.store;
}
async function application() {
  const owner = directory();
  owner.app = await createApp({
    dbPath: join(owner.path, 'app.sqlite'),
    buildId: 'v1-flow',
    testMode: true,
  });
  return owner.app;
}
async function api(
  app: App,
  url: string,
  payload?: unknown,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' = payload === undefined ? 'GET' : 'POST'
) {
  const result = await app.inject({
    method,
    url,
    headers: { host: '127.0.0.1', 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
  expect(result.statusCode, result.body).toBe(200);
  return result.json();
}
function story(store: Store, text = 'A scene', bot?: Content) {
  bot ??= store.product.content(fixtureBotInput('Story bot', 'Friendly')) as Content;
  return importChatTranscript(store, {
    idempotencyKey: randomUUID(),
    transcript: {
      format: 'uimori-chat-transcript',
      version: 2,
      exportedAt: new Date().toISOString(),
      title: 'Story',
      packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
      notes: [{ kind: 'author-note', author: 'user', text: 'Remember the blue key.', atIndex: 0 }],
      entries: [{ request: 'Write the first scene', text, translation: '장면 번역' }],
    },
  }).chat;
}

test('HTTP accepts an image over 2MiB and stores one WebP BLOB used by chat assets', async () => {
  const app = await application();
  const bot = app.store.product.content(fixtureBotInput()) as Content;
  const chat = app.store.createChat('Image test', 'calm', { botId: bot.id });
  const png = await sharp(randomBytes(1100 * 800 * 3), {
    raw: { width: 1100, height: 800, channels: 3 },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
  expect(png.length).toBeGreaterThan(2 * 1024 * 1024);
  const asset = await api(app, `/api/chats/${chat.id}/assets`, {
    title: 'Rain scene',
    description: 'A rainy evening',
    actor: '',
    outfit: '',
    location: '',
    allowedUse: 'inline',
    mime: 'image/png',
    base64: png.toString('base64'),
  });
  expect(asset.mime).toBe('image/webp');
  const response = await app.inject({ method: 'GET', url: asset.url });
  expect(response.headers['content-type']).toContain('image/webp');
  const metadata = await sharp(response.rawPayload).metadata();
  expect([metadata.width, metadata.height]).toEqual([1100, 800]);
  expect(app.store.db.prepare('SELECT count(*) AS n FROM image_blobs').get()?.n).toBe(1);
  expect(
    app.store.db
      .prepare('PRAGMA table_info(assets)')
      .all()
      .map((row) => row.name)
  ).not.toContain('bytes');
});

test('image metadata editing changes the JEV catalog without rewriting bytes or Risu aliases', async () => {
  const store = database();
  const image = await processImage(
    await sharp({ create: { width: 30, height: 20, channels: 4, background: '#88aacc' } })
      .png()
      .toBuffer()
  );
  storeImage(store.db, image);
  const input = fixtureBotInput('Images', 'The character stands in rain.');
  input.package.images = [
    {
      id: 'expression',
      title: 'old title',
      description: '',
      blobHash: image.hash,
      mime: 'image/webp',
      allowedUse: 'inline',
    },
  ];
  input.package.nativeRisu.assets = [
    { name: 'stable_script_alias', uri: 'embeded://expression.webp', imageId: 'expression' },
  ];
  const bot = store.product.content(input) as Content;
  const chat = story(store, 'A rain scene', bot);
  const model = editableResource(
    'content',
    bot
  ) as import('../core/resource-editing.js').ContentEditModel;
  model.package.images![0] = {
    ...model.package.images![0]!,
    title: '우산을 들고 웃는 모습',
    description: '비 오는 하굣길, 투명 우산',
  };
  saveResource(store, { kind: 'content', id: bot.id, expectedRevision: bot.revision, model });
  const profile = store.product.snapshot(chat.id);
  const inputCatalog = imageJobInput(store, {
    chatId: chat.id,
    request: 'A rain scene',
    profile,
    settings: chat.settings,
    history: [],
    resources: [],
    settingsRevision: chat.settingsRevision,
    parentRevision: chat.headRevision,
  });
  const source = store.source(chat.headRevision!);
  const request = imageJudgmentRequest(source, inputCatalog.imageCatalog.entries);
  expect(JSON.stringify(request)).toContain('우산을 들고 웃는 모습');
  expect(JSON.stringify(request)).toContain('비 오는 하굣길');
  expect(readImage(store.db, image.hash).bytes.equals(image.bytes)).toBe(true);
  expect(store.product.get<Content>('content', bot.id).package.nativeRisu!.assets[0]!.name).toBe(
    'stable_script_alias'
  );
});

test('renaming a resource invalidates only dependent chats and latest content has no revision history', () => {
  const store = database();
  const one = store.product.content(fixtureBotInput('One')) as Content;
  const two = store.product.content(fixtureBotInput('Two')) as Content;
  const a = story(store, 'a', one),
    b = story(store, 'b', two);
  const seq = Number(store.db.prepare('SELECT coalesce(max(seq),0) AS seq FROM events').get()!.seq);
  saveResource(store, {
    kind: 'content',
    id: one.id,
    expectedRevision: one.revision,
    model: nativeDraftTitle(editableResource('content', one), 'One updated'),
  });
  expect(
    store.db
      .prepare("SELECT chat_id FROM events WHERE seq>? AND kind='profile.updated'")
      .all(seq)
      .map((row) => row.chat_id)
  ).toEqual([a.id]);
  expect(store.product.snapshot(a.id).packages!.find((pkg) => pkg.id === one.id)?.title).toBe(
    'One updated'
  );
  expect(store.product.snapshot(b.id).packages!.find((pkg) => pkg.id === two.id)?.title).toBe(
    'Two'
  );
  expect(
    store.db.prepare("SELECT count(*) AS n FROM versions WHERE kind='content' AND id=?").get(one.id)
      ?.n
  ).toBe(1);
});

test('independent copies and portable restores retain inline images, notes and can accept another request', async () => {
  const source = database();
  const bot = source.product.content(fixtureBotInput('Inline bot')) as Content;
  const blank = source.createChat('Asset owner', 'calm', { botId: bot.id });
  const image = await processImage(
    await sharp({ create: { width: 12, height: 8, channels: 3, background: '#223344' } })
      .png()
      .toBuffer()
  );
  const asset = source.product.createAsset(blank.id, {
    title: 'inline',
    description: '',
    actor: '',
    outfit: '',
    location: '',
    allowedUse: 'inline',
    mime: image.mime,
    base64: image.bytes.toString('base64'),
  });
  const chat = story(source, `A scene\n![image](${asset.url})`, bot);
  const copy = forkChat(source, chat.id, {
    fromRevision: chat.headRevision,
    idempotencyKey: randomUUID(),
  });
  expect(copy.id).not.toBe(chat.id);
  expect(source.source(copy.headRevision!).text).toContain(
    `/api/package-image-blobs/${image.hash}`
  );
  source.db.prepare('DELETE FROM assets WHERE id=?').run(asset.id);
  const file = exportChatBackup(source, copy.id);
  const target = database();
  const restored = await importChatBackup(target, { backup: file, idempotencyKey: randomUUID() });
  expect(target.source(restored.chat.headRevision!).text).toContain(image.hash);
  expect(readImage(target.db, image.hash).bytes.equals(image.bytes)).toBe(true);
  expect(
    target.story.notes
      .entries(target.story.notes.scope(restored.chat.id, restored.chat.headRevision))
      .map((note) => note.text)
  ).toContain('Remember the blue key.');
  const next = target.createRun(
    restored.chat.id,
    {
      request: 'Continue',
      expectedRevision: restored.chat.headRevision,
      expectedSettingsRevision: restored.chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current) => ({
      chatId: current.id,
      request: 'Continue',
      parentRevision: current.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      history: target.history(current.headRevision),
      profile: target.product.snapshot(current.id),
      resources: [],
    })
  ).run;
  expect(next.parentRevision).toBe(restored.chat.headRevision);
  expect(next.snapshot.history[0]!.text).toContain('A scene');
  expect(target.product.branches(restored.chat.id)).toHaveLength(1);
});

test('full SQLite snapshot includes database keys and WebP bytes, never a server draft archive', async () => {
  const store = database();
  const connection = store.product.connection({
    title: 'Local',
    protocol: 'openai-chat-v1',
    endpoint: 'http://192.168.1.50:8080/v1',
    apiKey: 'private-key-for-test',
  });
  store.credentials.set('jev', 'private-jev-test-key');
  const image = await processImage(
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#669999' } })
      .png()
      .toBuffer()
  );
  storeImage(store.db, image);
  const owner = directory(),
    path = join(owner.path, 'restored.sqlite');
  await pipeline(await databaseBackupStream(store), createWriteStream(path, { flags: 'wx' }));
  const restored = new Store(path);
  owner.store = restored;
  expect(restored.credentials.get(connection.credentialRef)).toBe('private-key-for-test');
  expect(restored.credentials.get('jev')).toBe('private-jev-test-key');
  expect(readImage(restored.db, image.hash).bytes.equals(image.bytes)).toBe(true);
  expect(
    restored.db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'edit_draft%'").all()
  ).toEqual([]);
});

test('library helper can directly edit an unselected resource and rename another chat', async () => {
  const app = await application(),
    store = app.store;
  const bot = store.product.content(fixtureBotInput('Before')) as Content;
  const chat = story(store, 'A story', bot);
  const connection = store.product.connection({
    title: 'Synthetic',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Synthetic',
    connectionId: connection.id,
    modelId: 'fixture-helper',
    temperature: null,
    maxOutputTokens: 2048,
  });
  const current = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: current.revision,
    routes: { ...current.routes, main: { id: model.id } },
    helperModel: { id: model.id },
    translationPolicy: current.translationPolicy,
  });
  const success: transport.ProviderResult = {
    status: 'completed',
    text: 'Done',
    toolCalls: [],
    refusal: null,
    error: null,
    opaqueState: null,
    usage: { inputTokens: 10, outputTokens: 5, costUsd: null, raw: null, priceRevision: null },
  };
  let round = 0;
  vi.spyOn(transport, 'executeProvider').mockImplementation(async (_connection, request) => {
    expect(request.stable.tools.some((tool) => tool.name === 'app.tools')).toBe(true);
    expect(request.stable.tools.some((tool) => tool.name === 'app.call')).toBe(true);
    if (round++ === 0)
      return {
        ...success,
        status: 'tool_calls',
        text: '',
        toolCalls: [
          {
            id: 'edit',
            name: 'app.call',
            arguments: {
              name: 'resource.save',
              arguments: {
                kind: 'content',
                id: bot.id,
                expectedRevision: bot.revision,
                model: nativeDraftTitle(
                  editableResource('content', bot),
                  'Helper changed'
                ) as unknown as transport.Json,
              },
            },
          },
          {
            id: 'rename',
            name: 'app.call',
            arguments: {
              name: 'chat.rename',
              arguments: {
                chatId: chat.id,
                title: 'Changed from library',
                expectedRevision: chat.titleRevision ?? 0,
                operationId: 'rename-once',
              },
            },
          },
        ] as transport.ProviderToolCall[],
      };
    const events = request.input.results as unknown as {
      denied?: boolean;
      name: string;
      args: { name?: string };
      result: unknown;
    }[];
    const mutations = events.filter(
      (event) =>
        event.name === 'app.call' &&
        (event.args.name === 'resource.save' || event.args.name === 'chat.rename')
    );
    expect(mutations).toHaveLength(2);
    expect(mutations.every((event) => !event.denied)).toBe(true);
    return success;
  });
  const conversation = await api(app, '/api/helper/conversations', {
    scope: { kind: 'library', workId: 'freely-edit' },
  });
  const task = await api(app, `/api/helper/conversations/${conversation.id}/messages`, {
    requestKey: randomUUID(),
    text: '관련 자료를 자연스럽게 다듬어 주세요.',
  });
  const workspace = new HelperWorkspace(store);
  await vi.waitFor(() => expect(workspace.task(task.id).status).toBe('completed'), {
    timeout: 5000,
  });
  expect(store.product.get<Content>('content', bot.id).title).toBe('Helper changed');
  expect(store.chat(chat.id).title).toBe('Changed from library');
  expect(workspace.task(task.id).snapshot).not.toHaveProperty('grants');
});
