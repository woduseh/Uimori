import { readerConversation } from '../core/reader-conversation.js';
import type { ReaderRun } from '../core/types.js';
import { readerDetail, readerRuns } from '../server/reader.js';
import { updateTestProfile } from './fixtures/model-workspace.js';
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
      promptWorkspaceRevision: promptWorkspace(store).revision,
      models: { main: { id: model.id } },
      promptPresets: { main: { program } },
    },
  });
  expect(retry.run.snapshot.history.map((item) => item.text)).toEqual([first.source.text]);
  expect(store.chat(chat.id).headRevision).toBe(later.source.id);
  expect(store.run(selected.run.id)).toEqual(saved);
  updatePromptWorkspace(store, {
    expectedRevision: promptWorkspace(store).revision,
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

test('failed retries replace the visible attempt at the unchanged head and preserve immutable history across restore', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Failed recovery');
  const original = queued(store, chat.id);
  store.finishRun(original.id, 'failed', 'Synthetic failure');
  const frozen = structuredClone(store.run(original.id));
  const branchCount = store.product.branches(chat.id).length;
  const retry = store.retryRun(original.id, 'retry-failed').run;
  expect(retry.snapshot.branchId).toBe(original.snapshot.branchId);
  expect(store.product.branches(chat.id)).toHaveLength(branchCount);
  expect(readerRuns(store, chat.id).find((run) => run.id === original.id)?.supersededBy).toBe(
    retry.id
  );
  store.finishRun(retry.id, 'failed', 'Second failure');
  const edited = store.retryRun(retry.id, 'retry-edited', undefined, 'Edited request').run;
  store.startRun(edited.id);
  store.completeRun(
    edited.id,
    'Recovered response',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    edited.snapshot.settings
  );
  const visible = readerRuns(store, chat.id).filter((run) => !run.supersededBy);
  expect(visible.map((run) => run.id)).toEqual([edited.id]);
  expect(visible[0].request).toBe('Edited request');
  expect(store.run(original.id)).toEqual(frozen);
  expect(() => store.retryRun(original.id, 'stale-retry')).toThrow('newer attempt');
  expect(store.retryRun(original.id, 'retry-failed').created).toBe(false);
  const restored = database();
  restored.product.import(store.product.export());
  expect(readerRuns(restored, chat.id).map((run) => [run.id, run.supersededBy])).toEqual(
    readerRuns(store, chat.id).map((run) => [run.id, run.supersededBy])
  );
  // A historical page may omit the successful run; suppression still comes from durable metadata.
  expect(readerRuns(restored, chat.id, [original.id])[0].supersededBy).toBe(retry.id);
  expect(
    readerDetail(restored, chat.id, {})
      .runs.filter((run) => !run.supersededBy)
      .map((run) => run.id)
  ).toContain(edited.id);
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

test('independent failed turns keep request order through running, repeated failure, success and restore', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Ordered recovery');
  const a = queued(store, chat.id, 'A');
  store.finishRun(a.id, 'failed', 'A failed');
  const b = queued(store, chat.id, 'B');
  store.finishRun(b.id, 'failed', 'B failed');
  const retryA = store.retryRun(a.id, 'retry-A').run;
  const entries = (target: Store) => {
    const detail = readerDetail(target, chat.id, {});
    return readerConversation(detail.sources, detail.runs as ReaderRun[]).map((entry) =>
      entry.kind === 'source' ? entry.source.runId : entry.run.id
    );
  };
  expect(entries(store)).toEqual([retryA.id, b.id]);
  store.finishRun(retryA.id, 'failed', 'A failed again');
  expect(entries(store)).toEqual([retryA.id, b.id]);
  const retryB = store.retryRun(b.id, 'retry-B').run;
  expect(entries(store)).toEqual([retryA.id, retryB.id]);
  store.startRun(retryB.id);
  store.completeRun(
    retryB.id,
    'B success',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    retryB.snapshot.settings
  );
  expect(entries(store)).toEqual([retryA.id, retryB.id]);
  const restored = database();
  restored.product.import(store.product.export());
  expect(entries(restored)).toEqual([retryA.id, retryB.id]);
});

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
