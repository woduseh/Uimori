import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { clearPackagePresentationCaches } from '../server/package-presentation-routes.js';
import { fixtureBotInput } from './fixtures/chat.js';

const built = vi.hoisted(() => [] as { sourceId: string; translated: boolean }[]);
const held = vi.hoisted(() => ({ build: undefined as Promise<void> | undefined }));
vi.mock('../server/package-presentation.js', async (original) => {
  const actual = await original<typeof import('../server/package-presentation.js')>();
  return {
    ...actual,
    buildPackagePresentation: async (
      ...args: Parameters<typeof actual.buildPackagePresentation>
    ) => {
      built.push({ sourceId: args[1].id, translated: !!args[1].translation });
      await held.build;
      return actual.buildPackagePresentation(...args);
    },
  };
});

const backgroundWork = { timeout: 6000 };
const owned: { app: App; path: string }[] = [];
afterEach(async () => {
  clearPackagePresentationCaches();
  built.length = 0;
  held.build = undefined;
  for (const { app, path } of owned.splice(0)) {
    await app.close();
    rmSync(path, { recursive: true, force: true });
  }
});

async function scene(text: string, options: { accessToken?: string } = {}) {
  const path = mkdtempSync(join(tmpdir(), 'uimori-presentation-cache-'));
  const app = await createApp({
    dbPath: join(path, 'app.sqlite'),
    buildId: 'presentation-cache-test',
    testMode: true,
    ...options,
  });
  owned.push({ app, path });
  const bot = app.store.product.content(fixtureBotInput());
  const chat = importChatTranscript(
    app.store,
    {
      idempotencyKey: randomUUID(),
      transcript: {
        format: 'uimori-chat-transcript',
        version: 2,
        exportedAt: new Date().toISOString(),
        title: 'Presentation cache',
        packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
        notes: [],
        entries: [{ request: 'First scene', text, translation: null }],
      },
    },
    'library'
  ).chat;
  const url = `/api/chats/${chat.id}/sources/${chat.headRevision}/presentation`;
  return {
    app,
    chat,
    get: (query = '', headers: Record<string, string> = {}) =>
      app.inject({ method: 'GET', url: `${url}${query}`, headers }),
  };
}

test('a deterministic scene revalidates by ETag and repeats the same body', async () => {
  const { get } = await scene('미라는 문턱에서 멈췄다.');
  const first = await get('?viewportWidth=1280&viewportHeight=800');
  expect(first.statusCode).toBe(200);
  expect(first.headers['cache-control']).toBe('private, no-cache');
  const etag = String(first.headers.etag);
  expect(etag).toMatch(/^W\/"/u);
  const repeated = await get('?viewportWidth=1280&viewportHeight=800');
  expect(repeated.body).toBe(first.body);
  expect(repeated.headers.etag).toBe(etag);
  const revalidated = await get('?viewportWidth=1280&viewportHeight=800', {
    'if-none-match': etag,
  });
  expect(revalidated.statusCode).toBe(304);
  expect(revalidated.body).toBe('');
  const resized = await get('?viewportWidth=390&viewportHeight=844', { 'if-none-match': etag });
  expect(resized.statusCode).toBe(200);
  expect(resized.headers.etag).not.toBe(etag);
});

test('a scene that draws random numbers gets no ETag', async () => {
  const { get } = await scene('주사위: {{random::1,2,3,4,5,6,7,8,9}}');
  const first = await get();
  expect(first.statusCode).toBe(200);
  expect(first.headers.etag).toBeUndefined();
  expect((await get()).headers.etag).toBeUndefined();
});

test('revalidation never answers before authentication', async () => {
  const { get } = await scene('미라는 문턱에서 멈췄다.', {
    accessToken: 'synthetic-presentation-access-token',
  });
  const response = await get('', { 'if-none-match': '*' });
  expect(response.statusCode).toBe(401);
});

test('a finished translation and a finished run render their scene before it is read again', async () => {
  const { app, chat, get } = await scene('미라는 문턱에서 멈췄다.');
  const viewport = '?viewportWidth=1280&viewportHeight=800';
  const read = (sourceId: string) =>
    app.inject({
      method: 'GET',
      url: `/api/chats/${chat.id}/sources/${sourceId}/presentation${viewport}`,
    });
  expect((await get(viewport)).statusCode).toBe(200);
  const translation = await app.inject({
    method: 'POST',
    url: `/api/sources/${chat.headRevision}/translation`,
    payload: {},
  });
  expect(translation.statusCode).toBe(200);
  await expect
    .poll(
      () => built.some((entry) => entry.sourceId === chat.headRevision && entry.translated),
      backgroundWork
    )
    .toBe(true);
  const builds = built.length;
  expect((await get(viewport)).statusCode).toBe(200);
  expect(built.length).toBe(builds);

  const started = await app.inject({
    method: 'POST',
    url: `/api/chats/${chat.id}/runs`,
    payload: {
      request: '다음 장면',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(started.statusCode, started.body).toBe(200);
  const runId = started.json<{ id: string }>().id;
  await expect
    .poll(
      async () => (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json(),
      backgroundWork
    )
    .toMatchObject({ status: 'completed' });
  const sourceId = (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json<{
    sourceRevision: string;
  }>().sourceRevision;
  const buildsOf = (id: string) => built.filter((entry) => entry.sourceId === id).length;
  await expect.poll(() => buildsOf(sourceId), backgroundWork).toBe(1);
  expect((await read(sourceId)).statusCode).toBe(200);
  expect(buildsOf(sourceId)).toBe(1);
});

test('closing the app waits for a scene that is rendering in the background', async () => {
  const { app, chat, get } = await scene('미라는 문턱에서 멈췄다.');
  expect((await get('?viewportWidth=1280&viewportHeight=800')).statusCode).toBe(200);
  let release!: () => void;
  held.build = new Promise<void>((resolve) => {
    release = resolve;
  });
  const translation = await app.inject({
    method: 'POST',
    url: `/api/sources/${chat.headRevision}/translation`,
    payload: {},
  });
  expect(translation.statusCode).toBe(200);
  await expect.poll(() => built.some((entry) => entry.translated), backgroundWork).toBe(true);
  const { path } = owned.splice(0)[0];
  let closed = false;
  const closing = app.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(closed).toBe(false);
  release();
  await closing;
  rmSync(path, { recursive: true, force: true });
});
