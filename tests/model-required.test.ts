import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import { createFixtureChat } from './fixtures/chat.js';
import { prepareNativeFixtureRun } from './fixtures/native-run.js';

let app: App | undefined;
let directory: string | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  if (directory) {
    const target = resolve(directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-model-required-')
    )
      throw new Error('Unsafe cleanup');
    await rm(target, { recursive: true, force: true });
    directory = undefined;
  }
});

test('outside test mode, generation, translation and candidate requests with no model roll back without mock jobs or output', async () => {
  directory = await mkdtemp(join(tmpdir(), 'uimori-model-required-'));
  app = await createApp({ dbPath: join(directory, 'test.sqlite'), buildId: 'test' });
  const store = app.store;
  expect((await app.inject('/api/health')).json().testMode).toBe(false);
  const fixtureControl = await app.inject({
    method: 'POST',
    url: '/api/test/control',
    payload: { action: 'fixture' },
  });
  expect(fixtureControl.statusCode).toBe(404);
  const chat = createFixtureChat(store, 'Synthetic source');
  const generation = await app.inject({
    method: 'POST',
    url: `/api/chats/${chat.id}/runs`,
    payload: {
      request: 'Continue',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(generation.statusCode).toBe(409);
  expect(generation.json()).toEqual({ code: 'MODEL_REQUIRED', params: { role: 'main' } });
  expect(store.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 });
  const { run } = store.createRun(
    chat.id,
    {
      request: 'Authored fixture',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current) => ({
      chatId: current.id,
      parentRevision: null,
      settingsRevision: current.settingsRevision,
      settings: { ...current.settings },
      request: 'Authored fixture',
      history: [],
      resources: [],
      profile: store.product.snapshot(current.id),
    })
  );
  await prepareNativeFixtureRun(store, run);
  store.startRun(run.id);
  const source = store.completeRun(run.id, 'Authored source', {
    modelCalls: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  });
  const jobsBefore = store.db.prepare('SELECT count(*) AS n FROM jobs').get();
  for (const action of ['translation', 'retranslate']) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/${action}`,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: 'MODEL_REQUIRED', params: { role: 'translation' } });
    expect(store.db.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual(jobsBefore);
  }
  const response = await app.inject({
    method: 'POST',
    url: `/api/runs/${run.id}/retry`,
    payload: { idempotencyKey: randomUUID(), mode: 'copy' },
  });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ code: 'MODEL_REQUIRED', params: { role: 'main' } });
  expect(store.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 1 });
  expect(store.db.prepare('SELECT count(*) AS n FROM attempts').get()).toEqual({ n: 0 });
});

test('a queued translation that reaches the pump without a translation model stores the model requirement', async () => {
  directory = await mkdtemp(join(tmpdir(), 'uimori-model-required-'));
  const dbPath = join(directory, 'test.sqlite');
  app = await createApp({ dbPath, buildId: 'test' });
  const store = app.store;
  const chat = createFixtureChat(store, 'Synthetic source');
  const { run } = store.createRun(
    chat.id,
    {
      request: 'Authored fixture',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current) => ({
      chatId: current.id,
      parentRevision: null,
      settingsRevision: current.settingsRevision,
      settings: { ...current.settings },
      request: 'Authored fixture',
      history: [],
      resources: [],
      profile: store.product.snapshot(current.id),
    })
  );
  await prepareNativeFixtureRun(store, run);
  store.startRun(run.id);
  const source = store.completeRun(run.id, 'Authored source', {
    modelCalls: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  });
  const job = store.requestTranslation(source.id);
  await app.close();
  app = await createApp({ dbPath, buildId: 'test' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  await expect.poll(() => app!.store.job(job.id).status).toBe('failed');
  expect(app.store.job(job.id).error).toBe('MODEL_REQUIRED:translation');
});
