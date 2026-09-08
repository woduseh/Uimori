import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import { createFixtureChat } from './fixtures/chat.js';

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

for (const testMode of [false, true]) {
  test(`model-free generation is only available in explicit test mode (${testMode})`, async () => {
    directory = await mkdtemp(join(tmpdir(), 'uimori-model-required-'));
    app = await createApp({ dbPath: join(directory, 'test.sqlite'), buildId: 'test', testMode });
    expect((await app.inject('/api/health')).json().testMode).toBe(testMode);
    const chat = createFixtureChat(app.store, 'Synthetic chat');
    const response = await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/runs`,
      payload: {
        request: 'Continue',
        expectedRevision: null,
        expectedSettingsRevision: chat.settingsRevision,
        idempotencyKey: randomUUID(),
      },
    });
    if (!testMode) {
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('MODEL_REQUIRED:main');
      expect(app.store.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 });
      expect(app.store.db.prepare('SELECT count(*) AS n FROM attempts').get()).toEqual({ n: 0 });
    } else {
      expect(response.statusCode).toBe(200);
      await vi.waitFor(() => expect(app!.store.run(response.json().id).status).toBe('completed'));
    }
  });
}

test('normal translation and candidate requests with no model roll back without mock jobs or output', async () => {
  directory = await mkdtemp(join(tmpdir(), 'uimori-model-required-'));
  app = await createApp({ dbPath: join(directory, 'test.sqlite'), buildId: 'test' });
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
      settings: { ...current.settings, status: false },
      request: 'Authored fixture',
      history: [],
      resources: [],
      profile: store.product.snapshot(current.id),
    })
  );
  store.startRun(run.id);
  const source = store.completeRun(
    run.id,
    'Authored source',
    {
      modelCalls: 0,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    },
    run.snapshot.settings
  );
  const jobsBefore = store.db.prepare('SELECT count(*) AS n FROM jobs').get();
  for (const action of ['translation', 'retranslate']) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/${action}`,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('MODEL_REQUIRED:translation');
    expect(store.db.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual(jobsBefore);
  }
  const response = await app.inject({
    method: 'POST',
    url: `/api/runs/${run.id}/candidate`,
    payload: { idempotencyKey: randomUUID() },
  });
  expect(response.statusCode).toBe(409);
  expect(response.json().error).toBe('MODEL_REQUIRED:main');
  expect(store.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 1 });
  expect(store.db.prepare('SELECT count(*) AS n FROM attempts').get()).toEqual({ n: 0 });
});
