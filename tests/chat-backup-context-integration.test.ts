import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Store } from '../server/store.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { helperWritingSnapshot } from '../server/helper-runtime.js';
import {
  helperContext,
  helperHistory,
  publishHelperContext,
  readHelperChatContext,
  validateHelperContexts,
} from '../server/helper-context.js';
import {
  contextSourceRefs,
  contextDependencyKey,
  measureMainContext,
  withContextProjection,
} from '../server/context-planning.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { runStoryJob } from '../server/story-runner.js';
import { validateStoryArchive } from '../server/story-archive.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { store: Store; path: string }[] = [];
const usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
afterEach(() => {
  for (const { store, path } of owned.splice(0)) {
    store.close();
    const within = relative(resolve(tmpdir()), resolve(path));
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !within.startsWith('uimori-backup-context-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function database() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-backup-context-'));
  const store = new Store(join(path, 'synthetic.sqlite'));
  owned.push({ store, path });
  return store;
}
async function finishState(store: Store) {
  for (const id of store.story.queued()) {
    const job = store.story.claim(id, 'synthetic-worker');
    if (!job) continue;
    const result = await runStoryJob(store.story.bundle(id), {
      signal: new AbortController().signal,
      approvedOrigins: [],
      authorize: (value) => value,
      onInput: () => {},
      onToolEvent: () => {},
      onAttemptStart: () => {
        throw new Error('No provider calls');
      },
      onAttemptFinish: () => {},
    });
    expect(result.status).toBe('completed');
    store.story.finish(id, job.generation, 'synthetic-worker', result);
  }
}
async function turn(store: Store, chatId: string, branchId?: string) {
  const chat = store.chat(chatId),
    branch = store.product.branch(chatId, branchId);
  const request = '합성 후속 장면';
  const { run } = store.createRun(
    chatId,
    {
      request,
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
      ...(branchId ? { branchId } : {}),
    },
    (captured) => ({
      chatId,
      parentRevision: captured.headRevision,
      settingsRevision: captured.settingsRevision,
      settings: captured.settings,
      request,
      history: store.history(captured.headRevision),
      resources: [],
    })
  );
  store.startRun(run.id);
  const source = store.completeRun(
    run.id,
    '[[event:spend]] 미라는 약속을 기억했어요.',
    usage,
    run.snapshot.settings
  );
  await finishState(store);
  return source;
}

test('full portable roundtrip keeps state and main/helper summaries usable through copies and resumed work', async () => {
  const store = database();
  const connection = store.product.connection({
    title: 'Synthetic',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Synthetic',
    connectionId: connection.id,
    modelId: 'fixture',
    maxOutputTokens: 1024,
    temperature: null,
  });
  const selected = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: selected.revision,
    routes: { ...selected.routes, main: { id: model.id } },
    translationPolicy: selected.translationPolicy,
    helperModel: { id: model.id },
    contextModel: { id: model.id },
  });
  const chat = createFixtureChat(store, '복원 문맥');
  store.settings(chat.id, chat.settingsRevision, {
    ...chat.settings,
    translation: false,
    status: false,
  });
  store.story.saveConfig(chat.id, {
    expectedRevision: 0,
    stateModel: null,
    module: {
      id: 'coins',
      name: 'Synthetic',
      mode: 'authoritative',
      fields: { coins: { type: 'number', initial: 10, min: 0, max: 100 } },
      rules: { spend: { field: 'coins', delta: -1 } },
    },
  });
  const first = await turn(store, chat.id);
  const branch = store.product.createBranch(chat.id, { title: '대안', fromRevision: first.id });
  await turn(store, chat.id, branch.id);
  await turn(store, chat.id);
  store.story.notes.write(chat.id, {
    text: '미라는 아직 약속을 이행하지 않았어요.',
    author: 'user',
    expectedRevision: 0,
    expectedHeadRevision: store.chat(chat.id).headRevision,
    idempotencyKey: 'note',
  });
  const current = helperWritingSnapshot(store, chat.id, `main:${chat.id}`, 'context');
  const candidate = withContextProjection(
    current,
    contextSourceRefs(current).slice(0, 1),
    '미라는 약속을 기억하지만 이행하지 않았어요.'
  );
  candidate.contextPlan!.estimatedInputTokens = measureMainContext(candidate).estimatedInputTokens;
  const published = store.context.publishPrepared(candidate, { origin: 'automatic' });
  expect(published.contextPlan!.checkpoint).toBeDefined();
  expect(store.context.current(chat.id).usable).toBe(true);
  const contextJob = store.context.schedule(
    chat.id,
    {
      expectedRevision: 1,
      expectedHeadRevision: store.chat(chat.id).headRevision,
      idempotencyKey: 'context-cancel',
    },
    helperWritingSnapshot(store, chat.id, `main:${chat.id}`, 'context')
  );
  store.context.cancel(chat.id, contextJob.id);
  const edited = store.context.edit(
    chat.id,
    {
      expectedRevision: 1,
      expectedHeadRevision: store.chat(chat.id).headRevision,
      idempotencyKey: 'context-edit',
      summary: '미라는 약속을 기억해요. 아직 이행하지 않았어요.',
    },
    helperWritingSnapshot(store, chat.id, `main:${chat.id}`, 'context')
  );
  const helper = new HelperWorkspace(store),
    conversation = helper.open({ kind: 'chat', chatId: chat.id, branchId: `main:${chat.id}` });
  const task = helper.enqueue(conversation.id, 'helper-first', '작품 문맥을 설명해 줘', {
    scope: conversation.scope,
    model: store.product.modelSnapshot(model.id),
    history: [],
    persona: '',
    grants: [],
    limits: { totalCalls: 3, helperCalls: 3, artifacts: 1 },
    writing: helperWritingSnapshot(store, chat.id, `main:${chat.id}`),
    context: { activeRevision: 0, checkpoint: null },
  });
  expect(helper.start(task.id, 'synthetic-helper')).toBe(true);
  helper.event(conversation.id, task.id, 'tool.finished', {
    name: 'notes.write',
    denied: false,
    result: { chatId: chat.id, headRevision: first.id, text: chat.id },
  });
  helper.event(conversation.id, task.id, 'tool.finished', {
    name: 'context.edit',
    denied: false,
    result: edited,
  });
  helper.event(conversation.id, task.id, 'tool.finished', {
    name: 'context.read',
    denied: false,
    result: readHelperChatContext(store, chat.id, `main:${chat.id}`),
  });
  const helperCheckpoint = publishHelperContext(
    store,
    helper.task(task.id),
    1,
    '도우미는 미라의 약속을 확인했어요.',
    usage,
    100,
    task.snapshot.context!
  );
  expect(
    helper.finish(task.id, 'synthetic-helper', 1, 'completed', '아직 약속은 미이행 상태예요.', null)
  ).toBe(true);
  const next = helper.enqueue(conversation.id, 'helper-next', '계속 설명해 줘', {
    ...task.snapshot,
    history: helperHistory(store, conversation.id),
    context: {
      activeRevision: helperCheckpoint.activeRevision,
      checkpoint: helperCheckpoint.checkpoint,
    },
  });
  helper.cancel(next.id);
  const original = exportChatBackup(store, chat.id);
  expect(original.records.contextCheckpoints).toHaveLength(3);
  expect(original.records.storyStates).toHaveLength(3);
  let backup = original;
  const ids = new Set([chat.id]);
  for (let index = 0; index < 3; index++) {
    const imported = importChatBackup(store, { backup, idempotencyKey: `copy-${index}` });
    expect(ids.has(imported.chat.id)).toBe(false);
    ids.add(imported.chat.id);
    expect(imported.branches).toBe(2);
    expect(store.context.current(imported.chat.id).usable).toBe(true);
    expect(() => store.context.validateArchive()).not.toThrow();
    expect(() => validateHelperContexts(store)).not.toThrow();
    expect(() => validateStoryArchive(store)).not.toThrow();
    const restored = exportChatBackup(store, imported.chat.id);
    expect(restored.records.sources.map((row) => row.text)).toEqual(
      original.records.sources.map((row) => row.text)
    );
    expect(
      restored.records.contextCheckpoints.map((row) => (row.plan as { summary: string }).summary)
    ).toEqual(
      original.records.contextCheckpoints.map((row) => (row.plan as { summary: string }).summary)
    );
    const restoredConversation = String(restored.records.helperConversations[0].id);
    const contextReceipt = restored.records.contextOperations[0].result as any;
    const embedded = contextReceipt.jobs[0].snapshot;
    expect(embedded.chatId).toBe(imported.chat.id);
    expect(embedded.story.state.id).not.toBe(
      (original.records.contextOperations[0].result as any).jobs[0].snapshot.story.state.id
    );
    expect(embedded.contextPlan.dependencyKey).toBe(contextDependencyKey(embedded));
    expect(() => store.context.checkpoint(embedded.contextBase.checkpoint)).not.toThrow();
    const contextReadEvent = restored.records.helperEvents.find(
      (row) => (row.data as any)?.name === 'context.read'
    )!;
    const readResult = (contextReadEvent.data as any).result;
    expect(Object.keys(readResult.checkpoint.plan).sort()).toEqual([
      'compacted',
      'dependencyKey',
      'recentSourceRevisions',
      'summary',
    ]);
    expect(store.context.checkpoint(readResult.checkpoint).plan.dependencyKey).toBe(
      readResult.checkpoint.plan.dependencyKey
    );
    expect(
      helperContext(store, restoredConversation, helperHistory(store, restoredConversation))
        .checkpoint
    ).toBeTruthy();
    for (const row of restored.records.sources) expect(String(row.id)).toHaveLength(36);
    backup = restored;
    if (index === 2) {
      const before = helperWritingSnapshot(store, imported.chat.id, `main:${imported.chat.id}`);
      expect(before.story!.state!.values.coins).toBe(8);
      await turn(store, imported.chat.id);
      const after = helperWritingSnapshot(store, imported.chat.id, `main:${imported.chat.id}`);
      expect(after.story!.state!.values.coins).toBe(7);
      expect(() => validateStoryArchive(store)).not.toThrow();
    }
  }
  const target = database();
  expect(target.product.import(store.product.export()).restored).toBe(true);
}, 30000);
