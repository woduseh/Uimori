import { readStoredRunSnapshot } from '../server/run-projections.js';
import { readerConversation } from '../core/reader-conversation.js';
import type { ReaderRun } from '../core/types.js';
import { readerDetail } from '../server/reader.js';
import { updateTestProfile } from './fixtures/model-workspace.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { promptWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';
import { exportChatTranscript, importChatTranscript } from '../server/chat-transcript.js';

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
test('successful request repeats with current settings in an independent chat and idempotency reuses the original retry snapshot', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Retry current settings');
  const first = complete(store, chat.id, 'First ancestor'),
    selected = complete(store, chat.id, 'Original selected response'),
    later = complete(store, chat.id, 'Later default response');
  const saved = readStoredRunSnapshot(store, selected.run.id),
    oldChat = store.chat(chat.id);
  store.settings(chat.id, oldChat.settingsRevision, { ...oldChat.settings, maxCalls: 12 });
  const program = createDefaultRisuPrompt('Current main instructions');
  updatePromptWorkspace(store, {
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
  updateTestProfile(store.product, chat.id, {
    expectedRevision: profile.revision,
    packageAttachments: profile.packageAttachments,
    routes: { ...profile.routes, main: { id: model.id } },
    image: false,
  });
  const branches = store.product.branches(chat.id).length;
  const retry = store.retryRun(selected.run.id, 'repeat-once');
  expect(retry.created).toBe(true);
  expect(retry.run.id).not.toBe(selected.run.id);
  expect(retry.run.request).toBe(selected.run.request);
  expect(retry.run.chatId).not.toBe(chat.id);
  expect(store.source(retry.run.parentRevision!).text).toBe(first.source.text);
  expect(retry.run.snapshot.branchId).toBeTypeOf('string');
  expect(retry.run.snapshot.branchId).not.toBe(selected.run.snapshot.branchId);
  expect(store.product.branches(chat.id)).toHaveLength(branches);
  expect(retry.run.snapshot).toMatchObject({
    settings: { maxCalls: 12 },
    profile: {
      promptWorkspaceRevision: promptWorkspace(store).revision,
      models: { main: { id: model.id } },
      promptPresets: { main: { program } },
    },
  });
  expect(retry.run.snapshot.history.map((item) => item.text)).toEqual([first.source.text]);
  expect(store.chat(chat.id).headRevision).toBe(later.source.id);
  expect(readStoredRunSnapshot(store, selected.run.id)).toEqual(saved);
  updatePromptWorkspace(store, {
    expectedRevision: promptWorkspace(store).revision,
    main: {
      title: 'Later edit',
      program: createDefaultRisuPrompt('Do not replace retried snapshot'),
      values: {},
    },
  });
  expect(store.retryRun(selected.run.id, 'repeat-once')).toEqual({
    created: false,
    run: retry.run,
  });
  expect(store.product.branches(chat.id)).toHaveLength(branches);
  expect(store.retryRun(first.run.id, 'repeat-once').run.id).not.toBe(retry.run.id);
});

test('failed retry after the original head advances branches at its original parent', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Historical failure');
  const original = queued(store, chat.id);
  store.finishRun(original.id, 'failed', 'Synthetic failure');
  const later = complete(store, chat.id, 'Later response');
  const retry = store.retryRun(original.id, 'historical-retry').run;
  expect(retry.parentRevision).toBe(original.parentRevision);
  expect(retry.snapshot.branchId).not.toBe(original.snapshot.branchId);
  expect(retry.snapshot.history).toEqual([]);
  expect(store.chat(chat.id).headRevision).toBe(later.source.id);
});

test.each([4001, 20001])(
  'an imported %i-character request can be edited and regenerated without changing its original',
  (length) => {
    const store = database();
    const source = createFixtureChat(store, 'Long imported request');
    complete(store, source.id, 'Original scene');
    const transcript = exportChatTranscript(store, source.id);
    const request = '요'.repeat(length - 3) + '끝부분';
    transcript.entries[0].request = request;
    const imported = importChatTranscript(store, { transcript, idempotencyKey: randomUUID() });
    const original = store.run(store.source(imported.chat.headRevision!).runId);
    expect(original.request).toBe(request);
    const edited = `${request}\n수정한 전개`;
    const retry = store.retryRun(original.id, 'long-request-edit', undefined, edited);
    expect(retry.created).toBe(true);
    expect(retry.run.request).toBe(edited);
    expect(retry.run.snapshot.request).toBe(edited);
    expect(retry.run.chatId).not.toBe(imported.chat.id);
    store.startRun(retry.run.id);
    store.completeRun(
      retry.run.id,
      'Revised scene',
      { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
      retry.run.snapshot.settings
    );
    expect(exportChatTranscript(store, retry.run.chatId).entries[0]).toMatchObject({
      request: edited,
      text: 'Revised scene',
    });
    expect(exportChatTranscript(store, imported.chat.id).entries[0]).toMatchObject({
      request,
      text: 'Original scene',
    });
    expect(store.retryRun(original.id, 'long-request-edit', undefined, edited).created).toBe(false);
  }
);

test('pending turns follow five-source page boundaries without losing active work or source numbering', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Paged recovery');
  for (let index = 0; index < 5; index++) complete(store, chat.id, `Source ${index + 1}`);
  const failed = queued(store, chat.id, 'Between pages');
  store.finishRun(failed.id, 'failed', 'Failed between pages');
  const sixth = complete(store, chat.id, 'Source 6');
  complete(store, chat.id, 'Source 7');
  const first = readerDetail(store, chat.id, {});
  expect(first.sources).toHaveLength(5);
  expect(first.reader.pendingRunIds).not.toContain(failed.id);
  const last = readerDetail(store, chat.id, { source: sixth.source.id });
  expect(last.reader.start).toBe(5);
  expect(last.sources).toHaveLength(2);
  expect(last.reader.pendingRunIds).toContain(failed.id);
  const timeline = readerConversation(last.sources, last.runs as ReaderRun[]);
  expect(timeline[0]).toMatchObject({ kind: 'pending', run: { id: failed.id } });
  expect(timeline.filter((entry) => entry.kind === 'source').map((entry) => entry.index)).toEqual([
    0, 1,
  ]);
  const active = queued(store, chat.id, 'Active at latest head');
  expect(readerDetail(store, chat.id, {}).reader.pendingRunIds).toContain(active.id);
});
