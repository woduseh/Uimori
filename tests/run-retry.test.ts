import { readImportReceipt, saveImportReceipt } from '../server/import-operations.js';
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
import { editSource } from '../server/source-editing.js';
import { readChatVariables, writeChatVariables } from '../server/chat-variables.js';
import {
  contextSourceRefs,
  validateContextPlan,
  withContextProjection,
} from '../server/context-planning.js';

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
test('last response replacement keeps old prose until commit, excludes it from inputs, and preserves immutable history', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Replace last');
  const ancestor = complete(store, chat.id, 'Ancestor'),
    selected = complete(store, chat.id, 'Old response');
  const beforeChats = store.db.prepare('SELECT count(*) AS total FROM chats').get()!.total;
  const result = store.retryRun(
    selected.run.id,
    'replace-last',
    undefined,
    'Edited request',
    'replace'
  );
  expect(result.run.chatId).toBe(chat.id);
  expect(result.run.parentRevision).toBe(ancestor.source.id);
  expect(result.run.snapshot.history.map((item) => item.text)).toEqual(['Ancestor']);
  expect(result.run.snapshot.logicalHistory?.some((item) => item.text === 'Old response')).toBe(
    false
  );
  expect(store.chat(chat.id).headRevision).toBe(selected.source.id);
  expect(
    store.retryRun(selected.run.id, 'replace-last', undefined, 'Edited request', 'replace')
  ).toMatchObject({ created: false, run: { id: result.run.id } });
  expect(() =>
    store.retryRun(selected.run.id, 'replace-last', undefined, 'Edited request', 'copy')
  ).toThrow(/Idempotency/);
  store.startRun(result.run.id);
  const replacement = store.completeRun(
    result.run.id,
    'New response',
    selected.run.usage!,
    result.run.snapshot.settings
  );
  expect(replacement.parentRevision).toBe(ancestor.source.id);
  expect(store.history(store.chat(chat.id).headRevision).map((item) => item.text)).toEqual([
    'Ancestor',
    'New response',
  ]);
  expect(store.source(selected.source.id).text).toBe('Old response');
  expect(store.run(selected.run.id).status).toBe('completed');
  expect(store.db.prepare('SELECT count(*) AS total FROM chats').get()!.total).toBe(beforeChats);
  expect(() =>
    store.retryRun(selected.run.id, 'replace-middle', undefined, undefined, 'replace')
  ).toThrow(/마지막/);
  expect(
    store.retryRun(selected.run.id, 'copy-old', undefined, undefined, 'copy').run.chatId
  ).not.toBe(chat.id);
});

test.each(['failed', 'cancelled', 'refused'] as const)(
  'replacement %s retains the old response and retry keeps replacement intent',
  (status) => {
    const store = database(),
      chat = createFixtureChat(store, 'Replace failure');
    const selected = complete(store, chat.id, 'Keep me');
    const retry = store.retryRun(
      selected.run.id,
      `replace-${status}`,
      undefined,
      undefined,
      'replace'
    ).run;
    store.startRun(retry.id);
    store.finishRun(retry.id, status, 'Fixture failure');
    expect(store.chat(chat.id).headRevision).toBe(selected.source.id);
    expect(store.source(selected.source.id).text).toBe('Keep me');
    expect(() =>
      store.completeRun(retry.id, 'Late response', selected.run.usage!, retry.snapshot.settings)
    ).toThrow(/owns completion/);
    const repeated = store.retryRun(retry.id, 'retry-replacement').run;
    expect(repeated.chatId).toBe(chat.id);
    expect(repeated.snapshot.replacement?.sourceRevision).toBe(selected.source.id);
    expect(repeated.snapshot.history).toEqual([]);
  }
);

test('replacement completion rejects edits to the retained head and does not overwrite user prose', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Replace conflict');
  const selected = complete(store, chat.id, 'Original');
  const retry = store.retryRun(
    selected.run.id,
    'replace-edit',
    undefined,
    undefined,
    'replace'
  ).run;
  store.startRun(retry.id);
  editSource(store, selected.source.id, { expectedRevision: 0, text: 'User correction' });
  expect(() =>
    store.completeRun(retry.id, 'New response', selected.run.usage!, retry.snapshot.settings)
  ).toThrow(/revision changed/);
  expect(store.chat(chat.id).headRevision).toBe(selected.source.id);
  expect(store.source(selected.source.id).text).toBe('User correction');
});

test('replacement seeds ancestor variables and swaps state only after completion', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Replace variables');
  writeChatVariables(store, chat.id, {
    expectedRevision: 0,
    expectedSourceHash: null,
    idempotencyKey: 'base-vars',
    values: { scene: 'before' },
  });
  const ancestor = complete(store, chat.id, 'Ancestor');
  writeChatVariables(store, chat.id, {
    expectedRevision: 1,
    expectedSourceHash: ancestor.source.hash,
    idempotencyKey: 'next-vars',
    values: { scene: 'after' },
  });
  const selected = complete(store, chat.id, 'Old response');
  const retry = store.retryRun(
    selected.run.id,
    'replace-vars',
    undefined,
    undefined,
    'replace'
  ).run;
  expect(retry.snapshot.profile?.variableState).toEqual({
    revision: 2,
    values: { scene: 'before' },
  });
  expect(readChatVariables(store, chat.id)).toEqual({ revision: 2, values: { scene: 'after' } });
  store.startRun(retry.id);
  store.completeRun(retry.id, 'New response', selected.run.usage!, retry.snapshot.settings);
  expect(readChatVariables(store, chat.id)).toEqual({ revision: 3, values: { scene: 'before' } });
});
test('completed replacements can be replaced again and failed judgment recovery preserves replacement ownership', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Replace twice');
  const selected = complete(store, chat.id, 'Old response');
  const retry = store.retryRun(
    selected.run.id,
    'replace-first',
    undefined,
    undefined,
    'replace'
  ).run;
  store.startRun(retry.id);
  const newer = store.completeRun(
    retry.id,
    'First replacement',
    selected.run.usage!,
    retry.snapshot.settings
  );
  const next = store.retryRun(newer.runId, 'replace-second', undefined, undefined, 'replace').run;
  expect(next.snapshot.replacement?.sourceRevision).toBe(newer.id);
  const snapshot = {
    ...next.snapshot,
    mainJudgmentEnabled: true,
    mainJudgment: {
      version: 'main-refusal-jev-v2',
      candidateHash: newer.hash,
      response: 'Preserved candidate',
      threshold: 0.5,
    },
  };
  store.db.prepare('UPDATE runs SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot), next.id);
  store.startRun(next.id);
  store.finishRun(next.id, 'failed', 'JEV_CONNECTION_FAILED', 'Preserved candidate');
  const recovered = store.candidate(
    next.id,
    'rejudge-replacement',
    'Unused title',
    undefined,
    true
  ).run;
  expect(recovered.chatId).toBe(chat.id);
  expect(recovered.snapshot.judgmentRecovery).toBe(true);
  expect(recovered.snapshot.replacement?.sourceRevision).toBe(newer.id);
  store.startRun(recovered.id);
  const final = store.completeRun(
    recovered.id,
    'Preserved candidate',
    selected.run.usage!,
    recovered.snapshot.settings
  );
  expect(store.history(final.id).map((source) => source.text)).toEqual(['Preserved candidate']);
  const copy = store.candidate(next.id, 'candidate-failed-replacement', 'Explicit candidate').run;
  expect(copy.chatId).not.toBe(chat.id);
  expect(copy.snapshot.replacement).toBeUndefined();
});

test.each(['compacted', 'recent'] as const)(
  'replacement clears an active checkpoint with the old response in %s only after success and preserves its record',
  (location) => {
    const store = database(),
      chat = createFixtureChat(store, 'Replace checkpoint');
    const ancestor = complete(store, chat.id, 'Ancestor');
    const selected = complete(store, chat.id, 'Old response');
    const connection = store.product.connection({
      title: 'Synthetic context',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9',
      enabled: true,
    });
    const model = store.product.model({
      title: 'Synthetic context',
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
    const candidate = queued(store, chat.id);
    store.finishRun(candidate.id, 'cancelled', 'Fixture reservation only');
    const captured = store.context.prepareRun(candidate.snapshot);
    const snapshot = withContextProjection(
      captured,
      contextSourceRefs(captured).slice(0, location === 'compacted' ? 2 : 1),
      location === 'compacted' ? 'Ancestor and old response summary' : 'Ancestor summary'
    );
    snapshot.contextPlan!.estimatedInputTokens = 100;
    validateContextPlan(snapshot);
    const published = store.context.publishPrepared(snapshot, { origin: 'automatic' });
    const checkpoint = published.contextPlan!.checkpoint!;
    const scopeKey = `chat:${chat.id}`;
    const active = store.db
      .prepare('SELECT revision,checkpoint_id FROM context_heads WHERE scope_key=?')
      .get(scopeKey)!;
    expect(active.checkpoint_id).toBe(checkpoint.id);
    expect(store.context.checkpoint(checkpoint).activated).toBe(true);
    const cancelled = store.retryRun(
      selected.run.id,
      'checkpoint-cancelled',
      undefined,
      undefined,
      'replace'
    ).run;
    store.startRun(cancelled.id);
    store.finishRun(cancelled.id, 'cancelled', 'Cancelled');
    expect(
      store.db
        .prepare('SELECT revision,checkpoint_id FROM context_heads WHERE scope_key=?')
        .get(scopeKey)
    ).toEqual(active);
    const retry = store.retryRun(cancelled.id, 'checkpoint-success').run;
    store.startRun(retry.id);
    const source = store.completeRun(
      retry.id,
      'Replacement',
      selected.run.usage!,
      retry.snapshot.settings
    );
    expect(source.parentRevision).toBe(ancestor.source.id);
    expect(
      store.db
        .prepare('SELECT revision,checkpoint_id FROM context_heads WHERE scope_key=?')
        .get(scopeKey)
    ).toMatchObject({ revision: Number(active.revision) + 1, checkpoint_id: null });
    expect(store.context.checkpoint(checkpoint).plan).toEqual(snapshot.contextPlan);
  }
);

test('successful replacement revokes old unfinished auxiliaries while preserving completed artifacts', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Replace auxiliaries');
  const selected = complete(store, chat.id, 'Old response');
  const at = new Date().toISOString();
  for (const [index, status] of ['queued', 'running', 'completed'].entries()) {
    store.db
      .prepare(
        'INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,owner,generation,created_at,updated_at,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        `old-${status}`,
        chat.id,
        selected.source.id,
        selected.source.hash,
        'status',
        status,
        status === 'running' ? 'old-worker' : null,
        2,
        at,
        at,
        index + 50
      );
    store.db
      .prepare(
        "INSERT INTO illustration_jobs(id,chat_id,source_revision,source_hash,origin,status,owner,generation,input,created_at,updated_at) VALUES(?,?,?,?,'automatic',?,?,2,'{}',?,?)"
      )
      .run(
        `image-${status}`,
        chat.id,
        selected.source.id,
        selected.source.hash,
        status,
        status === 'running' ? 'old-worker' : null,
        at,
        at
      );
  }
  const failed = store.retryRun(
    selected.run.id,
    'replace-aux-failed',
    undefined,
    undefined,
    'replace'
  ).run;
  store.startRun(failed.id);
  store.finishRun(failed.id, 'cancelled', 'Cancelled');
  expect(store.db.prepare("SELECT status FROM jobs WHERE id='old-running'").get()!.status).toBe(
    'running'
  );
  const retry = store.retryRun(failed.id, 'replace-aux-success').run;
  store.startRun(retry.id);
  store.completeRun(retry.id, 'New response', selected.run.usage!, retry.snapshot.settings);
  for (const table of ['jobs', 'illustration_jobs']) {
    for (const status of ['queued', 'running']) {
      const job = store.db
        .prepare(`SELECT status,generation,owner FROM ${table} WHERE id=?`)
        .get(`${table === 'jobs' ? 'old' : 'image'}-${status}`);
      expect(job).toMatchObject({ status: 'cancelled', generation: 3, owner: null });
    }
    expect(
      store.db
        .prepare(`SELECT status,generation FROM ${table} WHERE id=?`)
        .get(`${table === 'jobs' ? 'old' : 'image'}-completed`)
    ).toMatchObject({ status: 'completed', generation: 2 });
  }
});

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
  const originalChat = store.chat(chat.id);
  const retry = store.retryRun(selected.run.id, 'repeat-once');
  expect(retry.created).toBe(true);
  expect(retry.run.id).not.toBe(selected.run.id);
  expect(retry.run.request).toBe(selected.run.request);
  expect(retry.run.chatId).not.toBe(chat.id);
  expect(store.source(retry.run.parentRevision!).text).toBe(first.source.text);
  expect(retry.run.snapshot.chatId).toBe(retry.run.chatId);
  expect(store.chat(chat.id)).toEqual(originalChat);
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
  // Ordinary imports retain only their own recent receipts, never retry/fork identities.
  for (let index = 0; index < 300; index++)
    saveImportReceipt(store, `resource-${index}`, 'digest', { index });
  expect(readImportReceipt(store, 'resource-0', 'digest')).toBeUndefined();
  expect(readImportReceipt(store, 'resource-299', 'digest')).toEqual({ index: 299 });
  expect(store.retryRun(selected.run.id, 'repeat-once')).toEqual({
    created: false,
    run: retry.run,
  });
  expect(store.chat(chat.id)).toEqual(originalChat);
  expect(store.retryRun(first.run.id, 'repeat-once').run.id).not.toBe(retry.run.id);
});

test('failed retry after the original head advances copies a chat at its original parent', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Historical failure');
  const original = queued(store, chat.id);
  store.finishRun(original.id, 'failed', 'Synthetic failure');
  const later = complete(store, chat.id, 'Later response');
  const retry = store.retryRun(original.id, 'historical-retry').run;
  expect(store.chat(retry.chatId).title).toBe('Historical failure · 사본 1');
  expect(retry.parentRevision).toBe(original.parentRevision);
  expect(retry.chatId).not.toBe(original.chatId);
  expect(retry.snapshot.chatId).toBe(retry.chatId);
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
