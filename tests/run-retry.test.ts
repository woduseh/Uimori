import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { promptWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';

const owned: { path: string; store: Store }[] = [];
function database() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-run-retry-'));
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
      !basename(path).startsWith('uimori-run-retry-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
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
function complete(store: Store, chatId: string, text: string) {
  const run = queued(store, chatId);
  store.startRun(run.id);
  const source = store.completeRun(
    run.id,
    text,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
  return { run: store.run(run.id), source };
}
test('successful request repeats with current settings in a new branch and idempotency reuses the original retry snapshot', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Retry current settings');
  const first = complete(store, chat.id, 'First ancestor'),
    selected = complete(store, chat.id, 'Original selected response'),
    later = complete(store, chat.id, 'Later default response');
  const saved = structuredClone(selected.run),
    oldChat = store.chat(chat.id);
  store.settings(chat.id, oldChat.settingsRevision, { ...oldChat.settings, maxCalls: 12 });
  const program = createDefaultPromptProgram('Current main instructions');
  const current = updatePromptWorkspace(store, {
    expectedRevision: promptWorkspace(store).revision,
    main: { title: 'Current', program, values: {} },
  });
  const connection = store.product.connection({
    title: 'Current connection',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Current model',
    connectionId: connection.id,
    modelId: 'fixture',
    maxOutputTokens: 1024,
    temperature: null,
  });
  const profile = store.product.profile(chat.id);
  store.product.updateProfile(chat.id, {
    expectedRevision: profile.revision,
    attachments: profile.attachments,
    routes: { ...profile.routes, main: { id: model.id } },
    image: false,
  });
  const branches = store.product.branches(chat.id).length;
  const retry = store.retryRun(selected.run.id, 'repeat-once');
  expect(retry.created).toBe(true);
  expect(retry.run.id).not.toBe(selected.run.id);
  expect(retry.run.request).toBe(selected.run.request);
  expect(retry.run.parentRevision).toBe(first.source.id);
  expect(retry.run.snapshot.branchId).toBeTypeOf('string');
  expect(retry.run.snapshot.branchId).not.toBe(selected.run.snapshot.branchId);
  expect(store.product.branches(chat.id)).toHaveLength(branches + 1);
  expect(retry.run.snapshot).toMatchObject({
    settings: { maxCalls: 12 },
    profile: {
      promptWorkspaceRevision: current.revision,
      models: { main: { id: model.id } },
      promptPresets: { main: { program } },
    },
  });
  expect(retry.run.snapshot.history.map((item) => item.text)).toEqual([first.source.text]);
  expect(store.chat(chat.id).headRevision).toBe(later.source.id);
  expect(store.run(selected.run.id)).toEqual(saved);
  updatePromptWorkspace(store, {
    expectedRevision: current.revision,
    main: {
      title: 'Later edit',
      program: createDefaultPromptProgram('Do not replace retried snapshot'),
      values: {},
    },
  });
  expect(store.retryRun(selected.run.id, 'repeat-once')).toEqual({
    created: false,
    run: retry.run,
  });
  expect(store.product.branches(chat.id)).toHaveLength(branches + 1);
  expect(() => store.retryRun(first.run.id, 'repeat-once')).toThrow('Idempotency');
});
test('active requests cannot repeat and validation failure rolls back both new branch and run', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Retry rollback');
  const completeRun = complete(store, chat.id, 'Completed source');
  const before = store.product.export().tables;
  expect(() =>
    store.retryRun(completeRun.run.id, 'failed-validation', () => {
      throw new Error('Rejected current snapshot');
    })
  ).toThrow('Rejected current snapshot');
  expect(store.product.export().tables).toEqual(before);
  const active = queued(store, chat.id);
  expect(() => store.retryRun(active.id, 'active-repeat')).toThrow('still active');
});
