import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { queueAutomaticRefusalRetry, retryRun } from '../server/run-retry.js';
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
