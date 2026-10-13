import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../server/app.js';
import { createFixtureChat } from './fixtures/chat.js';
import { completedSource } from './fixtures/illustration.js';

let current: { app: App; directory: string } | null = null;
afterEach(async () => {
  if (!current) return;
  await current.app.close();
  rmSync(current.directory, { recursive: true, force: true });
  current = null;
});

test('activity inbox ignores historic output, groups auto translation, and persists individual confirmation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-feed-'));
  const app = await createApp({
    dbPath: join(directory, 'app.sqlite'),
    buildId: 'activity-feed-test',
    testMode: true,
  });
  current = { app, directory };
  const chat = createFixtureChat(app.store, 'Synthetic chat');
  const source = completedSource(app.store, chat.id, 'Private old scene');
  const initial = await app.inject('/api/activity-feed');
  expect(initial.statusCode).toBe(200);
  expect(initial.json()).toMatchObject({ items: [], running: [] });

  const time = new Date(Date.now() + 1000).toISOString();
  const jobId = randomUUID();
  app.store.db
    .prepare(`INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,input,error,created_at,updated_at)
    VALUES(?,?,?,?,'translation','failed',?,'Synthetic interrupted translation',?,?)`)
    .run(
      jobId,
      chat.id,
      source.id,
      source.hash,
      JSON.stringify({ autoTranslateRunId: source.runId }),
      time,
      time
    );
  const response = await app.inject('/api/activity-feed');
  expect(response.statusCode).toBe(200);
  const { items } = response.json();
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    chatId: chat.id,
    kind: 'translation',
    status: 'failed',
    sourceId: source.id,
    representation: 'original',
    actionable: true,
    canAcknowledge: true,
  });
  expect(response.body).not.toContain('Private old scene');
  const key = items[0].acknowledgementKey;
  const ack = await app.inject({
    method: 'POST',
    url: `/api/chats/${chat.id}/activity-acknowledgements`,
    payload: { keys: [key] },
  });
  expect(ack.statusCode).toBe(200);
  const again = await app.inject({
    method: 'POST',
    url: `/api/chats/${chat.id}/activity-acknowledgements`,
    payload: { keys: [key] },
  });
  expect(again.statusCode).toBe(200);
  expect((await app.inject('/api/activity-feed')).json().items).toEqual([]);
  expect((await app.inject(`/api/chats/${chat.id}/activity-acknowledgements`)).json()).toEqual({
    keys: [key],
  });
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/chats/${chat.id}/activity-acknowledgements`,
        payload: { keys: Array.from({ length: 101 }, () => key) },
      })
    ).statusCode
  ).toBe(400);
});

test('automatic translation replaces a real completed-run notice instead of duplicating it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-feed-'));
  const app = await createApp({
    dbPath: join(directory, 'app.sqlite'),
    buildId: 'activity-auto-test',
    testMode: true,
  });
  current = { app, directory };
  const store = app.store;
  const chat = createFixtureChat(store, 'Automatic writing');
  const run = store.createRun(
    chat.id,
    {
      request: 'A new story',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (selected) => ({
      chatId: chat.id,
      parentRevision: selected.headRevision,
      settingsRevision: selected.settingsRevision,
      settings: selected.settings,
      request: 'A new story',
      history: [],
      resources: [],
    })
  ).run;
  store.startRun(run.id);
  const attempt = store.product.startAttempt(chat.id, run.id, null, {
    connectionId: 'synthetic-provider',
    modelId: 'synthetic-model',
    role: 'main',
    protocol: 'openai-chat-v1',
    method: 'POST',
    url: 'https://provider.invalid',
    headers: {},
    body: {},
    bodySha256: 'synthetic',
    stablePrefixSha256: 'synthetic',
  });
  store.product.finishAttempt(attempt, {
    status: 'completed',
    text: 'Private story body',
    toolCalls: [],
    refusal: null,
    error: null,
    opaqueState: null,
    usage: { inputTokens: 1, outputTokens: 1, costUsd: null, priceRevision: null, raw: null },
  });
  const source = store.completeRun(run.id, 'Private story body', {
    modelCalls: 1,
    inputTokens: 1,
    outputTokens: 1,
    costUsd: null,
  });
  const single = (await app.inject('/api/activity-feed')).json();
  expect(single.items).toMatchObject([{ kind: 'main', status: 'completed', sourceId: source.id }]);
  const at = new Date(Date.now() + 1000).toISOString();
  store.db
    .prepare(`INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,input,error,created_at,updated_at)
    VALUES(?,?,?,?,'translation','failed',?,'Synthetic translation failure',?,?)`)
    .run(
      randomUUID(),
      chat.id,
      source.id,
      source.hash,
      JSON.stringify({ autoTranslateRunId: run.id }),
      at,
      at
    );
  const combined = (await app.inject('/api/activity-feed')).json();
  expect(combined.items).toHaveLength(1);
  expect(combined.items[0]).toMatchObject({
    kind: 'translation',
    status: 'failed',
    label: '자동 번역 실패 · 원문 확인 가능',
  });
});
