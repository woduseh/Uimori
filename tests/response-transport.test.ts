import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import { createApp, type App } from '../server/app.js';
import { readerDetail } from '../server/reader.js';
import { editTranslation } from '../server/source-editing.js';
import { splitSource } from '../core/auxiliary.js';
import { createFixtureChat, fixtureBotInput, setFixtureModelRoutes } from './fixtures/chat.js';
import type { Store } from '../server/store.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const local = { host: '127.0.0.1' };

async function application(options: { accessToken?: string; publicOrigin?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-response-transport-'));
  const app: App = await createApp({
    dbPath: join(directory, 'app.sqlite'),
    buildId: 'response-transport-synthetic',
    testMode: options.publicOrigin === undefined,
    ...options,
  });
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  cleanup.push(() => app.close());
  return app;
}

function scene(store: Store, chatId: string, text: string) {
  const chat = store.chat(chatId);
  const run = store.createRun(
    chatId,
    {
      request: 'Synthetic request',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current) => ({
      chatId,
      parentRevision: current.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request: 'Synthetic request',
      history: store.history(current.headRevision),
      resources: [],
    })
  ).run;
  store.startRun(run.id);
  return store.source(
    store.completeRun(run.id, text, {
      modelCalls: 0,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    }).id
  );
}

const ORIGINAL =
  'Opening line.\r\nSecond line 😀.\r\n\r\n```js\r\nconst a = 1;\r\n\r\nconst b = "𝒳";\r\n```\r\n\r\n🎭 Final paragraph with 𠜎 and é.\n\nTrailing\rCR paragraph\r\n';
const TRANSLATED = '첫 줄 😀.\r\n\r\n~~~\r\n코드\r\n\r\n블록 𝒳\r\n~~~\n\n마지막 𠜎.\r\n';

test('the reader sends block ranges whose slices reproduce every block text', async () => {
  const app = await application();
  const chat = createFixtureChat(app.store, 'Reader ranges');
  const source = scene(app.store, chat.id, ORIGINAL);
  editTranslation(app.store, source.id, {
    text: TRANSLATED,
    expectedRevision: 0,
    expectedSourceHash: source.hash,
  });
  app.store.retranslate(source.id);
  const detail = readerDetail(app.store, chat.id, {});
  const [sent] = detail.sources;
  const originalBlocks = splitSource(app.store.source(source.id));
  expect(originalBlocks.some((block) => block.text.includes('```'))).toBe(true);
  expect(sent!.blocks).toHaveLength(originalBlocks.length);
  for (const [index, block] of sent!.blocks!.entries()) {
    expect(block).not.toHaveProperty('text');
    expect(sent!.text.slice(block.start, block.end)).toBe(originalBlocks[index]!.text);
    expect(block.anchor).toBe(originalBlocks[index]!.anchor);
  }
  const job = detail.jobs.find((item) => item.kind === 'translation')!;
  const previous = job.previousResult!;
  const translatedBlocks = splitSource({
    id: source.id,
    chatId: chat.id,
    text: TRANSLATED,
    hash: previous.translationLayout!.textHash,
  });
  expect(previous.translationLayout!.blocks).toHaveLength(translatedBlocks.length);
  for (const [index, block] of previous.translationLayout!.blocks.entries()) {
    expect(block).not.toHaveProperty('text');
    expect(previous.result.text!.slice(block.start, block.end)).toBe(translatedBlocks[index]!.text);
  }
  expect(app.store.source(source.id).blocks![0]!.text).toBe(originalBlocks[0]!.text);
  expect(app.store.job(previous.jobId).translationLayout!.blocks[0]!.text).toBe(
    translatedBlocks[0]!.text
  );
});

test('JSON responses compress with brotli while event streams stay unencoded and unbuffered', async () => {
  const app = await application();
  const chat = createFixtureChat(app.store, 'Compressed reader');
  scene(app.store, chat.id, 'A long synthetic paragraph. '.repeat(200));
  const identity = await app.inject({ url: `/api/chats/${chat.id}/reader`, headers: local });
  const encoded = await app.inject({
    url: `/api/chats/${chat.id}/reader`,
    headers: { ...local, 'accept-encoding': 'br, gzip' },
  });
  expect(identity.headers['content-encoding']).toBeUndefined();
  expect(encoded.headers['content-encoding']).toBe('br');
  expect(encoded.headers.vary).toMatch(/accept-encoding/iu);
  expect(encoded.headers.etag).toBe(identity.headers.etag);
  expect(brotliDecompressSync(encoded.rawPayload).toString()).toBe(identity.body);
  expect(encoded.rawPayload.length).toBeLessThan(identity.rawPayload.length / 4);

  const metrics = (await app.inject({ url: '/api/diagnostics/metrics', headers: local })).json();
  const readerMetrics = metrics.routes.find(
    (route: { route: string }) => route.route === '/api/chats/:id/reader'
  );
  expect(readerMetrics.responseBytes.total).toBe(2 * Buffer.byteLength(identity.body));

  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const controller = new AbortController();
  cleanup.push(async () => controller.abort());
  const stream = await fetch(`${address}/api/events?chat=${encodeURIComponent(chat.id)}`, {
    headers: { 'accept-encoding': 'br, gzip' },
    signal: controller.signal,
  });
  expect(stream.headers.get('content-encoding')).toBeNull();
  expect(stream.headers.get('content-type')).toBe('text/event-stream');
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let received = '';
  while (!received.includes('"kind":"snapshot"'))
    received += decoder.decode((await reader.read()).value);
  await setFixtureModelRoutes(app, { main: null, translation: null });
  while (!received.includes('prompt-workspace.updated'))
    received += decoder.decode((await reader.read()).value);
  controller.abort();
});

test('a Risu export download is sent as stored', async () => {
  const app = await application();
  const preset = app.store.product.promptPreset({
    title: 'Exported preset',
    role: 'main',
    program: {
      version: 1,
      nativeRisuPreset: {
        version: 1,
        preset: {
          promptTemplate: [
            { type: 'plain', role: 'system', text: 'A long synthetic rule. '.repeat(200) },
          ],
        },
      },
    },
  }) as { id: string };
  const exported = await app.inject({
    url: `/api/prompt-presets/${preset.id}/risu-export`,
    headers: { ...local, 'accept-encoding': 'br, gzip' },
  });
  expect(exported.statusCode).toBe(200);
  expect(exported.headers['content-type']).toBe('application/octet-stream');
  expect(exported.rawPayload.length).toBeGreaterThan(1024);
  expect(exported.headers['content-encoding']).toBeUndefined();
});

test('private ETags revalidate only after authentication', async () => {
  const accessToken = 'synthetic-etag-access-token-0123456789';
  const publicOrigin = 'https://story.example.test';
  const app = await application({ accessToken, publicOrigin });
  const headers = { host: 'story.example.test', origin: publicOrigin };
  const login = await app.inject({
    method: 'POST',
    url: '/api/session',
    headers,
    payload: { token: accessToken },
  });
  const authed = { ...headers, cookie: String(login.headers['set-cookie']).split(';')[0]! };
  const bot = await app.inject({
    method: 'POST',
    url: '/api/content',
    headers: authed,
    payload: fixtureBotInput(),
  });
  const createChat = (title: string) =>
    app.inject({
      method: 'POST',
      url: '/api/chats',
      headers: authed,
      payload: { title, botId: bot.json().id },
    });
  await createChat('First synthetic chat');

  const first = await app.inject({ url: '/api/chats', headers: authed });
  expect(first.statusCode).toBe(200);
  expect(first.headers['cache-control']).toBe('private, no-cache');
  const etag = String(first.headers.etag);
  expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/u);

  for (const ifNoneMatch of [etag, '*']) {
    const denied = await app.inject({
      url: '/api/chats',
      headers: { ...headers, 'if-none-match': ifNoneMatch },
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers.etag).toBeUndefined();
  }

  const revalidated = await app.inject({
    url: '/api/chats',
    headers: { ...authed, 'if-none-match': `"other", ${etag}`, 'accept-encoding': 'br' },
  });
  expect(revalidated.statusCode).toBe(304);
  expect(revalidated.body).toBe('');
  expect(revalidated.headers['content-encoding']).toBeUndefined();
  expect(revalidated.headers.etag).toBe(etag);

  await createChat('Second synthetic chat');
  const changed = await app.inject({
    url: '/api/chats',
    headers: { ...authed, 'if-none-match': etag },
  });
  expect(changed.statusCode).toBe(200);
  expect(changed.headers.etag).not.toBe(etag);
  expect(changed.json()).toHaveLength(2);

  const metrics = (await app.inject({ url: '/api/diagnostics/metrics', headers: authed })).json();
  expect(metrics.routes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ route: '/api/chats', method: 'GET', notModified: 1, errors: 2 }),
    ])
  );
  const session = await app.inject({ url: '/api/session', headers: authed });
  expect(session.headers.etag).toBeUndefined();
});

test('a repeated run request key honors Prefer: return=minimal', async () => {
  const app = await application();
  const chat = createFixtureChat(app.store, 'Idempotent run');
  app.controls.hold('run');
  const payload = {
    request: 'Synthetic request',
    expectedRevision: null,
    expectedSettingsRevision: chat.settingsRevision,
    idempotencyKey: 'synthetic-repeated-key',
  };
  const post = (body: typeof payload, prefer?: string) =>
    app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/runs`,
      headers: { ...local, ...(prefer ? { prefer } : {}) },
      payload: body,
    });
  const created = await post(payload, 'return=minimal');
  const repeated = await post(payload, 'return=minimal');
  expect(created.statusCode).toBe(200);
  expect(repeated.json()).not.toHaveProperty('snapshot');
  expect(repeated.json().id).toBe(created.json().id);
  expect(Object.keys(repeated.json()).sort()).toEqual(Object.keys(created.json()).sort());
  expect((await post(payload)).json()).toHaveProperty('snapshot');
  expect((await post({ ...payload, request: 'Different request' })).statusCode).toBe(409);
  app.controls.release('run');
});

test('private reads mark refusals no-store as well as answers', async () => {
  const app = await application();
  for (const url of [
    '/api/usage?from=2026-11-01&to=2026-11-28',
    '/api/push?clientId=synthetic-client',
    '/api/lore-context-defaults',
    '/api/maintenance',
  ]) {
    for (const [request, status] of [
      [url, 200],
      [`${url}${url.includes('?') ? '&' : '?'}unknown=1`, 400],
    ] as const) {
      const response = await app.inject({ url: request, headers: local });
      expect(response.statusCode, `${request}: ${response.body}`).toBe(status);
      expect(response.headers['cache-control'], request).toBe('no-store');
    }
  }
});
