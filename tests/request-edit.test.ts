import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { path: string; store: Store }[] = [];
afterEach(() => {
  for (const { path, store } of owned.splice(0)) {
    store.close();
    const within = relative(tmpdir(), path);
    if (isAbsolute(within) || within.startsWith('..') || !within.startsWith('uimori-edit-'))
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function setup() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-edit-'));
  const store = new Store(join(path, 'story.sqlite'));
  owned.push({ path, store });
  return { store, chat: createFixtureChat(store, 'Request edit') };
}
function queued(store: Store, chatId: string) {
  const chat = store.chat(chatId);
  const profile = store.product.snapshot(chatId);
  return store.createRun(
    chatId,
    {
      request: 'Original request',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current) => ({
      chatId,
      parentRevision: current.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request: 'Original request',
      history: store.history(current.headRevision),
      resources: store.product.resources(chatId, profile),
      profile,
    })
  ).run;
}
function complete(store: Store, chatId: string, sourceText: string) {
  const run = queued(store, chatId);
  store.startRun(run.id);
  const source = store.completeRun(
    run.id,
    sourceText,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
  return { run: store.run(run.id), source };
}

test('edited request branches before the response using current settings and preserves later conversation', () => {
  const { store, chat } = setup();
  const ancestor = complete(store, chat.id, 'Ancestor');
  const original = complete(store, chat.id, 'Original answer');
  const later = complete(store, chat.id, 'Later answer');
  const before = structuredClone(original.run);
  const current = store.chat(chat.id);
  store.settings(chat.id, current.settingsRevision, { ...current.settings, maxCalls: 12 });
  const edited = store.retryRun(original.run.id, 'edited', undefined, '  Revised request\n');
  expect(edited.created).toBe(true);
  expect(edited.run.request).toBe('  Revised request\n');
  expect(edited.run.snapshot.request).toBe(edited.run.request);
  expect(edited.run.parentRevision).toBe(ancestor.source.id);
  expect(edited.run.snapshot.settings.maxCalls).toBe(12);
  expect(edited.run.snapshot.history.map((entry) => entry.text)).toEqual(['Ancestor']);
  expect(edited.run.snapshot.branchId).not.toBe(original.run.snapshot.branchId);
  expect(store.chat(chat.id).headRevision).toBe(later.source.id);
  expect(store.run(original.run.id)).toEqual(before);
  expect(store.history(later.source.id).map((entry) => entry.text)).toEqual([
    'Ancestor',
    'Original answer',
    'Later answer',
  ]);
  expect(store.retryRun(original.run.id, 'edited', undefined, edited.run.request)).toEqual({
    created: false,
    run: edited.run,
  });
  expect(() => store.retryRun(original.run.id, 'edited', undefined, 'Different')).toThrow(
    'Idempotency'
  );
  expect(() => store.retryRun(original.run.id, 'edited')).toThrow('Idempotency');
});

test('same text still distinguishes edit from retry and rejects invalid edits without creating a branch', () => {
  const { store, chat } = setup();
  const original = complete(store, chat.id, 'Answer');
  store.retryRun(original.run.id, 'repeat');
  expect(() => store.retryRun(original.run.id, 'repeat', undefined, original.run.request)).toThrow(
    'Idempotency'
  );
  const before = store.product.export().tables;
  for (const request of ['', '   ', 'a'.repeat(4001)]) {
    expect(() => store.retryRun(original.run.id, randomUUID(), undefined, request)).toThrow(
      'Invalid request'
    );
  }
  expect(() =>
    store.retryRun(
      original.run.id,
      'invalid-model',
      () => {
        throw new Error('Current model unavailable');
      },
      'Edited'
    )
  ).toThrow('Current model unavailable');
  expect(store.product.export().tables).toEqual(before);
});

test('editing an active request is rejected before mutation', () => {
  const { store, chat } = setup();
  const run = queued(store, chat.id);
  const before = store.product.export().tables;
  expect(() => store.retryRun(run.id, 'active-edit', undefined, 'Edited')).toThrow('still active');
  expect(store.product.export().tables).toEqual(before);
});
