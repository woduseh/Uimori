import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { RunSnapshot, Usage } from '../core/types.js';
import { Controls } from '../server/controls.js';
import { HttpError, Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { directory: string; store: Store }[] = [];
const noUsage: Usage = {
  modelCalls: 1,
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
};

afterEach(() => {
  for (const item of owned.splice(0).reverse()) {
    item.store.close();
    const target = resolve(item.directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-pending-output-')
    )
      throw new Error('Refusing cleanup outside owned test directory');
    rmSync(target, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-pending-output-'));
  const store = new Store(join(directory, 'story.sqlite'));
  owned.push({ directory, store });
  const chat = createFixtureChat(store, 'Pending main output');
  return { store, chat };
}

function queued(store: Store, chatId: string) {
  const chat = store.chat(chatId);
  const captured = store.product.snapshot(chatId);
  const branch = store.product.branch(chatId);
  return store.createRun(
    chatId,
    {
      request: 'Continue the synthetic story.',
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current) =>
      ({
        chatId,
        parentRevision: current.headRevision,
        settingsRevision: current.settingsRevision,
        settings: current.settings,
        request: 'Continue the synthetic story.',
        history: store.history(current.headRevision),
        resources: store.product.resources(chatId, captured),
        ...(captured ? { profile: captured } : {}),
      }) satisfies RunSnapshot
  ).run;
}

function rawRun(store: Store, id: string) {
  return store.db
    .prepare('SELECT status,source_revision,partial_text,usage FROM runs WHERE id=?')
    .get(id) as {
    status: string;
    source_revision: string | null;
    partial_text: string | null;
    usage: string | null;
  };
}

test('a running main output is fixed once and terminal or unknown runs reject staging', () => {
  const { store, chat } = fixture();
  const run = queued(store, chat.id);
  expect(() => store.stageRunOutput(run.id, 'too early')).toThrow(HttpError);
  expect(store.startRun(run.id)).toBe(true);
  expect(() => store.stageRunOutput(run.id, 1 as unknown as string)).toThrowError(
    'Invalid run output'
  );

  expect(store.stageRunOutput(run.id, '')).toMatchObject({ status: 'running', partialText: '' });
  expect(store.stageRunOutput(run.id, '')).toMatchObject({ status: 'running', partialText: '' });
  expect(
    store.db
      .prepare(
        "SELECT count(*) AS count FROM events WHERE kind='run.output.staged' AND entity_id=?"
      )
      .get(run.id)
  ).toEqual({ count: 1 });
  expect(() => store.stageRunOutput(run.id, 'conflicting output')).toThrowError(
    'Run output is already staged'
  );

  store.finishRun(run.id, 'cancelled', 'Synthetic cancellation');
  expect(() => store.stageRunOutput(run.id, '')).toThrowError('Run no longer owns output');
  expect(() => store.stageRunOutput(randomUUID(), 'unknown')).toThrowError('Run not found');
  expect(rawRun(store, run.id).partial_text).toBe('');

  const explicitlyCleared = queued(store, chat.id);
  store.startRun(explicitlyCleared.id);
  store.stageRunOutput(explicitlyCleared.id, 'discarded terminal fragment');
  store.finishRun(explicitlyCleared.id, 'failed', 'Synthetic failure', '');
  expect(rawRun(store, explicitlyCleared.id).partial_text).toBe('');
});

test('cancellation and recovery preserve staged text without publishing source or state, and usage settles later', () => {
  const { store, chat } = fixture();
  const run = queued(store, chat.id);
  store.startRun(run.id);
  store.stageRunOutput(run.id, 'Canonical provider text');
  store.finishRun(run.id, 'cancelled', 'Cancelled while post-processing');
  const recoveryChat = createFixtureChat(store, 'Interrupted pending main output');
  const interrupted = queued(store, recoveryChat.id);
  store.startRun(interrupted.id);
  store.stageRunOutput(interrupted.id, 'Text received before server stop');

  expect(rawRun(store, run.id)).toEqual({
    status: 'cancelled',
    source_revision: null,
    partial_text: 'Canonical provider text',
    usage: null,
  });
  store.recover();
  expect(rawRun(store, run.id)).toEqual({
    status: 'cancelled',
    source_revision: null,
    partial_text: 'Canonical provider text',
    usage: null,
  });
  expect(rawRun(store, interrupted.id)).toEqual({
    status: 'interrupted',
    source_revision: null,
    partial_text: 'Text received before server stop',
    usage: null,
  });
  expect(store.db.prepare('SELECT count(*) AS count FROM sources').get()).toEqual({ count: 0 });
  expect(store.db.prepare('SELECT count(*) AS count FROM story_states').get()).toEqual({
    count: 0,
  });
  expect(store.db.prepare('SELECT count(*) AS count FROM package_behavior_states').get()).toEqual({
    count: 0,
  });

  store.settleCancelledUsage(run.id, noUsage);
  expect(rawRun(store, run.id)).toEqual({
    status: 'cancelled',
    source_revision: null,
    partial_text: 'Canonical provider text',
    usage: JSON.stringify(noUsage),
  });
});

test('source completion clears the staged duplicate atomically and rollback retains it', () => {
  const { store, chat } = fixture();
  const run = queued(store, chat.id);
  store.startRun(run.id);
  store.stageRunOutput(run.id, 'Canonical provider text');
  const controls = new Controls();
  controls.failures.add('source-transaction');

  expect(() =>
    store.completeRun(run.id, 'Published prose', noUsage, run.snapshot.settings, controls)
  ).toThrow('source-transaction');
  expect(rawRun(store, run.id)).toEqual({
    status: 'running',
    source_revision: null,
    partial_text: 'Canonical provider text',
    usage: null,
  });
  expect(store.db.prepare('SELECT count(*) AS count FROM sources').get()).toEqual({ count: 0 });

  const source = store.completeRun(run.id, 'Published prose', noUsage, run.snapshot.settings);
  expect(source.text).toBe('Published prose');
  expect(rawRun(store, run.id)).toEqual({
    status: 'completed',
    source_revision: source.id,
    partial_text: null,
    usage: JSON.stringify(noUsage),
  });
});
