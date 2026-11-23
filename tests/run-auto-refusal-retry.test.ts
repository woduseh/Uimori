import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import {
  finishRefusalWithAutomaticRetry,
  queueAutomaticRefusalRetry,
  retryRun,
} from '../server/run-retry.js';
import { HttpError } from '../server/request-validation.js';
import { DEFAULT_PUSH_PREFERENCES } from '../core/push.js';
import { saveChatGenerationDefaults } from '../server/chat-generation-defaults.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { path: string; store: Store }[] = [];
function database() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-auto-refusal-retry-'));
  const store = new Store(join(path, 'story.sqlite'));
  owned.push({ path, store });
  return store;
}
afterEach(() => {
  for (const { path, store } of owned.splice(0)) {
    store.close();
    const within = relative(resolve(tmpdir()), resolve(path));
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-auto-refusal-retry-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
const usage = { modelCalls: 2, inputTokens: 18, outputTokens: 5, costUsd: 0.01 };
const anyModel = () => {};
function queued(store: Store, chatId: string, request = 'Requested scene') {
  const chat = store.chat(chatId),
    profile = store.product.snapshot(chatId);
  return store.createRun(
    chatId,
    {
      request,
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current) => ({
      chatId,
      parentRevision: current.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request,
      history: store.history(current.headRevision),
      resources: store.product.resources(chatId, profile),
      profile,
    })
  ).run;
}
function refuse(store: Store, runId: string) {
  store.startRun(runId);
  store.finishRun(runId, 'refused', 'MAIN_RESPONSE_REFUSED', 'Refused text', usage);
}
const runCount = (store: Store, chatId: string) =>
  store.db.prepare('SELECT count(*) AS total FROM runs WHERE chat_id=?').get(chatId)!.total;
function subscribe(store: Store) {
  const at = new Date().toISOString();
  store.db
    .prepare('INSERT INTO access_sessions(token_hash,authority_hash) VALUES(?,?)')
    .run('synthetic-session', 'synthetic-authority');
  store.db
    .prepare(`INSERT INTO push_subscriptions(id,client_id,session_hash,endpoint,keys,preferences,origin,revision,created_at,updated_at)
      VALUES('synthetic-device','synthetic-client','synthetic-session','https://push.example.test/device','{}',?,'https://story.example.test',1,?,?)`)
    .run(JSON.stringify(DEFAULT_PUSH_PREFERENCES), at, at);
}
const failurePushes = (store: Store) =>
  (
    store.db
      .prepare("SELECT event_key AS eventKey FROM push_outbox WHERE kind='task-failed'")
      .all() as { eventKey: string }[]
  ).map((row) => row.eventKey);
const refusal = {
  status: 'refused' as const,
  error: 'MAIN_RESPONSE_REFUSED',
  partialText: 'Refused text',
  usage,
};
function finishRefusal(
  store: Store,
  runId: string,
  options: { retryAllowed?: boolean; requireModel?: () => void } = {}
) {
  store.startRun(runId);
  return finishRefusalWithAutomaticRetry(store, runId, refusal, {
    retryAllowed: options.retryAllowed ?? true,
    requireModel: options.requireModel ?? anyModel,
  });
}

test('a refusal that queues its automatic retry sends no failure push until the last refusal', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Push');
  subscribe(store);
  const root = queued(store, chat.id);
  const first = finishRefusal(store, root.id)!;
  expect(first.status).toBe('queued');
  expect(store.run(root.id)).toMatchObject({
    status: 'refused',
    partialText: 'Refused text',
    usage,
  });
  expect(failurePushes(store)).toEqual([]);
  const second = finishRefusal(store, first.id)!;
  expect(failurePushes(store)).toEqual([]);
  expect(finishRefusal(store, second.id)).toBeUndefined();
  expect(failurePushes(store)).toEqual([`run:${second.id}:refused`]);
  expect(runCount(store, chat.id)).toBe(3);
});

test('a refusal that cannot retry is the final outcome and sends the failure push', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Final');
  subscribe(store);
  const stopping = queued(store, chat.id);
  expect(finishRefusal(store, stopping.id, { retryAllowed: false })).toBeUndefined();
  const rejected = queued(store, chat.id);
  expect(
    finishRefusal(store, rejected.id, {
      requireModel: () => {
        throw new HttpError(400, 'MODEL_REQUIRED:main');
      },
    })
  ).toBeUndefined();
  const disabled = queued(store, chat.id);
  const current = store.chat(chat.id);
  store.settings(chat.id, current.settingsRevision, {
    ...current.settings,
    autoRefusalRetryEnabled: false,
  });
  expect(finishRefusal(store, disabled.id)).toBeUndefined();
  expect(failurePushes(store).sort()).toEqual(
    [stopping.id, rejected.id, disabled.id].map((id) => `run:${id}:refused`).sort()
  );
  expect(runCount(store, chat.id)).toBe(3);
});

test('the refusal and its retry commit together or not at all', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Atomic');
  subscribe(store);
  const run = queued(store, chat.id);
  expect(() =>
    finishRefusal(store, run.id, {
      requireModel: () => {
        throw new Error('synthetic crash');
      },
    })
  ).toThrow('synthetic crash');
  expect(store.run(run.id).status).toBe('running');
  expect(runCount(store, chat.id)).toBe(1);
  expect(failurePushes(store)).toEqual([]);
  store.recover();
  expect(store.run(run.id).status).toBe('interrupted');
  expect(runCount(store, chat.id)).toBe(1);
});

test('the automatic count follows its own chain and a manual retry starts a new count', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Automatic count');
  const root = queued(store, chat.id);
  refuse(store, root.id);
  const first = queueAutomaticRefusalRetry(store, root.id, anyModel)!;
  expect(first.status).toBe('queued');
  refuse(store, first.id);
  const second = queueAutomaticRefusalRetry(store, first.id, anyModel)!;
  refuse(store, second.id);
  expect(queueAutomaticRefusalRetry(store, second.id, anyModel)).toBeUndefined();
  expect(store.run(root.id)).toMatchObject({
    status: 'refused',
    partialText: 'Refused text',
    usage,
  });
  const manual = retryRun(store, second.id, randomUUID()).run;
  refuse(store, manual.id);
  expect(queueAutomaticRefusalRetry(store, manual.id, anyModel)?.status).toBe('queued');
  expect(runCount(store, chat.id)).toBe(5);
});

test('a repeated or post-restart request queues no second retry', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Restart');
  const root = queued(store, chat.id);
  refuse(store, root.id);
  const retry = queueAutomaticRefusalRetry(store, root.id, anyModel)!;
  expect(queueAutomaticRefusalRetry(store, root.id, anyModel)).toBeUndefined();
  store.recover();
  expect(store.run(retry.id).status).toBe('interrupted');
  expect(queueAutomaticRefusalRetry(store, root.id, anyModel)).toBeUndefined();
  expect(store.run(root.id)).toMatchObject({ status: 'refused', usage });
  expect(runCount(store, chat.id)).toBe(2);
});

test('settings, a moved head and an ended status other than refusal stop the retry', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Stops');
  const cancelled = queued(store, chat.id);
  store.startRun(cancelled.id);
  store.finishRun(cancelled.id, 'cancelled', 'Run cancelled');
  expect(queueAutomaticRefusalRetry(store, cancelled.id, anyModel)).toBeUndefined();

  const disabled = queued(store, chat.id);
  refuse(store, disabled.id);
  const current = store.chat(chat.id);
  store.settings(chat.id, current.settingsRevision, {
    ...current.settings,
    autoRefusalRetryEnabled: false,
  });
  expect(queueAutomaticRefusalRetry(store, disabled.id, anyModel)).toBeUndefined();
  const overridden = store.chat(chat.id);
  store.settings(chat.id, overridden.settingsRevision, { maxCalls: overridden.settings.maxCalls });
  saveChatGenerationDefaults(store, {
    expectedRevision: 0,
    maxCalls: 8,
    storyUi: false,
    storyUiStyle: 'auto',
    autoRefusalMaxRetries: 0,
  });
  expect(queueAutomaticRefusalRetry(store, disabled.id, anyModel)).toBeUndefined();
  saveChatGenerationDefaults(store, {
    expectedRevision: 1,
    maxCalls: 8,
    storyUi: false,
    storyUiStyle: 'auto',
    autoRefusalMaxRetries: 2,
  });

  const moved = queued(store, chat.id);
  refuse(store, moved.id);
  const scene = queued(store, chat.id);
  store.startRun(scene.id);
  store.completeRun(scene.id, 'A newer scene', usage);
  expect(queueAutomaticRefusalRetry(store, moved.id, anyModel)).toBeUndefined();
  expect(runCount(store, chat.id)).toBe(4);
});
