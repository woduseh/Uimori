import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { HelperTask } from '../core/helper.js';
import { createApp } from '../server/app.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { invokeTaskTool, type TaskControlActions } from '../server/helper-task-tools.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { Store } from '../server/store.js';
import * as transport from '../core/transport.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { store: Store; path: string }[] = [];
afterEach(() => {
  for (const { store, path } of owned.splice(0)) {
    store.close();
    const inside = relative(resolve(tmpdir()), resolve(path));
    if (isAbsolute(inside) || inside.startsWith('..') || !basename(path).startsWith('uimori-task-'))
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});

function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-task-'));
  const store = new Store(join(path, 'story.sqlite'));
  owned.push({ store, path });
  const workspace = new HelperWorkspace(store);
  const current = {
    id: 'current-helper',
    snapshot: { scope: { kind: 'library', workId: 'test' } },
  } as HelperTask;
  const actions: TaskControlActions = {
    cancelRun: (id) => {
      store.finishRun(id, 'cancelled', 'Run cancelled');
    },
    retryRun: (id, key) => ({ id: store.retryRun(id, key).run.id }),
    cancelJob: (id) => {
      store.cancelJob(id);
    },
    retryJob: (id) => ({ id: store.retryJob(id).id }),
    cancelIllustration: () => {
      throw new Error('unused');
    },
    retryIllustration: () => {
      throw new Error('unused');
    },
    cancelHelper: (id) => {
      workspace.cancel(id);
    },
    retryHelper: (id, key) => {
      const previous = workspace.task(id);
      return {
        id: workspace.enqueue(previous.conversationId, key, previous.request, {
          ...previous.snapshot,
          retryOf: previous.id,
        }).id,
      };
    },
  };
  const invoke = (name: string, kind: string, id: string, operationId = randomUUID()) =>
    invokeTaskTool(store, current, name, { kind, id }, operationId, actions);
  return { store, workspace, current, actions, invoke };
}

function queuedRun(store: Store, chatId: string) {
  const chat = store.chat(chatId);
  const profile = store.product.snapshot(chatId);
  return store.createRun(
    chatId,
    {
      request: '다음 장면',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current) => ({
      chatId,
      parentRevision: current.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request: '다음 장면',
      history: store.history(current.headRevision),
      resources: store.product.resources(chatId, profile),
      profile,
    })
  ).run;
}

test('completed run inspection is compact and retry returns the forked chat and new task ID', () => {
  const f = fixture();
  const chat = createFixtureChat(f.store, '작업 조회');
  const run = queuedRun(f.store, chat.id);
  f.store.startRun(run.id);
  f.store.completeRun(
    run.id,
    '완성된 장면',
    { modelCalls: 1, inputTokens: 3, outputTokens: 4, costUsd: null },
    run.snapshot.settings
  );
  const inspection = f.invoke('task.inspect', 'run', run.id);
  expect(inspection).toMatchObject({
    id: run.id,
    chatId: chat.id,
    status: 'completed',
    canCancel: false,
    canRetry: true,
    usage: { modelCalls: 1 },
  });
  expect(JSON.stringify(inspection)).not.toContain('완성된 장면');
  expect(JSON.stringify(inspection)).not.toContain('snapshot');

  const retried = f.invoke('task.retry', 'run', run.id);
  expect(retried).toMatchObject({ previousTaskId: run.id, task: { status: 'queued' } });
  const newTask = (retried as { task: { id: string; chatId: string } }).task;
  expect(newTask.id).not.toBe(run.id);
  expect(newTask.chatId).not.toBe(chat.id);
  expect(f.store.run(newTask.id).chatId).toBe(newTask.chatId);
});

test('cancellation routes to the existing run transition and rejects inactive or self targets', () => {
  const f = fixture();
  const chat = createFixtureChat(f.store, '취소 작업');
  const run = queuedRun(f.store, chat.id);
  expect(f.invoke('task.cancel', 'run', run.id)).toMatchObject({
    status: 'cancelled',
    canCancel: false,
  });
  expect(f.store.run(run.id).status).toBe('cancelled');
  expect(() => f.invoke('task.cancel', 'run', run.id)).toThrow('TASK_NOT_CANCELLABLE');

  const conversation = f.workspace.open({ kind: 'library', workId: 'self' });
  const helperTask = f.workspace.enqueue(conversation.id, 'current', '요청', {
    scope: conversation.scope,
    model: {} as never,
    history: [],
    persona: '',
    limits: { totalCalls: 3, helperCalls: 2, artifacts: 0 },
  });
  f.current.id = helperTask.id;
  const rejectedCancel = vi.fn();
  f.actions.cancelHelper = rejectedCancel;
  expect(() => f.invoke('task.cancel', 'helper', helperTask.id)).toThrow('CURRENT_HELPER_TASK');
  expect(() => f.invoke('task.retry', 'helper', helperTask.id)).toThrow('CURRENT_HELPER_TASK');
  expect(rejectedCancel).not.toHaveBeenCalled();
  expect(f.workspace.task(helperTask.id).status).toBe('queued');
});

test('task.list finds queued work before any provider attempt and scopes to the current chat', () => {
  const f = fixture();
  const chat = createFixtureChat(f.store, '현재 채팅');
  const other = createFixtureChat(f.store, '다른 채팅');
  const queued = queuedRun(f.store, chat.id);
  const otherQueued = queuedRun(f.store, other.id);
  f.current.snapshot.scope = { kind: 'chat', chatId: chat.id };
  expect(
    f.store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE run_id=?').get(queued.id)
  ).toEqual({ n: 0 });
  const listed = invokeTaskTool(f.store, f.current, 'task.list', {}, 'list', f.actions) as {
    status: string;
    chatId: string;
    tasks: { id: string; kind: string; status: string }[];
  };
  expect(listed).toMatchObject({ status: 'active', chatId: chat.id });
  expect(listed.tasks).toContainEqual(
    expect.objectContaining({ id: queued.id, kind: 'run', status: 'queued' })
  );
  expect(listed.tasks.some((task) => task.id === otherQueued.id)).toBe(false);
});

test('failed auxiliary job keeps its kind and usage while retrying through the job owner', () => {
  const f = fixture();
  const chat = createFixtureChat(f.store, '보조 작업');
  const run = queuedRun(f.store, chat.id);
  f.store.startRun(run.id);
  const source = f.store.completeRun(
    run.id,
    '원문',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
  const id = randomUUID();
  const at = new Date().toISOString();
  f.store.db
    .prepare(
      "INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,revision,input,error,created_at,updated_at) VALUES(?,?,?,?,'status','failed',1,'{}','provider failed',?,?)"
    )
    .run(id, chat.id, source.id, source.hash, at, at);
  for (const [input, cost] of [
    [11, 0.001],
    [null, null],
  ] as const)
    f.store.db
      .prepare(
        "INSERT INTO attempts(id,job_id,role,connection_id,model_id,status,request,input_tokens,output_tokens,cost_usd) VALUES(? ,?,'status','synthetic','synthetic','failed','{}',?,4,?)"
      )
      .run(randomUUID(), id, input, cost);
  expect(f.invoke('task.inspect', 'job', id)).toMatchObject({
    id,
    jobKind: 'status',
    status: 'failed',
    error: 'provider failed',
    canRetry: true,
    usage: { modelCalls: 2, inputTokens: null, outputTokens: 8, costUsd: null },
  });
  expect(f.invoke('task.retry', 'job', id)).toMatchObject({
    previousTaskId: id,
    task: { id, status: 'queued', canRetry: false },
  });
});

test('a helper retry replaces only one failed task and makes the old task ineligible', () => {
  const f = fixture();
  const conversation = f.workspace.open({ kind: 'library', workId: 'retry' });
  const previous = f.workspace.enqueue(conversation.id, 'original', '작업해 줘', {
    scope: conversation.scope,
    model: {} as never,
    history: [],
    persona: '',
    limits: { totalCalls: 3, helperCalls: 2, artifacts: 0 },
  });
  f.store.db
    .prepare("UPDATE helper_tasks SET status='failed',error='PROVIDER_FAILED' WHERE id=?")
    .run(previous.id);
  const attemptId = randomUUID();
  f.store.db
    .prepare(
      "INSERT INTO attempts(id,role,connection_id,model_id,status,request,input_tokens,output_tokens,cost_usd,raw_usage) VALUES(?,'helper','native','native','failed','{}',20,6,NULL,?)"
    )
    .run(attemptId, JSON.stringify({ modelCalls: null }));
  f.store.db
    .prepare('INSERT INTO helper_task_attempts(task_id,attempt_id,purpose,segment) VALUES(?,?,?,1)')
    .run(previous.id, attemptId, 'helper');
  for (const event of [
    {
      name: 'data.read',
      originalResultChars: 12000,
      providedResultChars: 1000,
      elapsedMs: 35,
      queueMs: 4,
      result: 'private source body',
    },
    {
      name: 'task.inspect',
      originalResultChars: 600,
      providedResultChars: 600,
      elapsedMs: 0,
      queueMs: 0,
    },
  ])
    f.workspace.event(conversation.id, previous.id, 'tool.finished', event);
  expect(f.invoke('task.inspect', 'helper', previous.id)).toMatchObject({
    diagnostics: { toolResultSizes: { calls: 2, timedCalls: 2, elapsedMs: 35, queueMs: 4 } },
  });
  f.workspace.event(conversation.id, previous.id, 'tool.finished', {
    name: 'data.read',
    originalResultChars: 120,
    providedResultChars: 100,
  });
  expect(f.invoke('task.inspect', 'helper', previous.id)).toMatchObject({
    status: 'failed',
    error: 'PROVIDER_FAILED',
    canRetry: true,
    diagnostics: {
      attemptsByPurpose: [
        {
          purpose: 'helper',
          usage: { modelCalls: 1, inputTokens: 20, outputTokens: 6, costUsd: null },
          internalModelCalls: null,
          unknownInternalModelCallAttempts: 1,
        },
      ],
      toolResultSizes: {
        calls: 3,
        originalChars: 12720,
        providedChars: 1700,
        timedCalls: 2,
        elapsedMs: null,
        queueMs: null,
        byTool: [
          {
            name: 'data.read',
            calls: 2,
            originalChars: 12120,
            providedChars: 1100,
            timedCalls: 1,
            elapsedMs: null,
            queueMs: null,
          },
          {
            name: 'task.inspect',
            calls: 1,
            originalChars: 600,
            providedChars: 600,
            timedCalls: 1,
            elapsedMs: 0,
            queueMs: 0,
          },
        ],
      },
    },
  });
  expect(JSON.stringify(f.invoke('task.inspect', 'helper', previous.id))).not.toContain(
    'private source body'
  );
  const retried = f.invoke('task.retry', 'helper', previous.id);
  expect(retried).toMatchObject({ previousTaskId: previous.id, task: { status: 'queued' } });
  expect((retried as { task: { id: string } }).task.id).not.toBe(previous.id);
  expect(f.invoke('task.inspect', 'helper', previous.id)).toMatchObject({
    canRetry: false,
    retryBlock: 'HELPER_ALREADY_RETRIED',
  });
});

test('a failed helper receipt rolls back a run retry before any main provider call', async () => {
  const path = mkdtempSync(join(tmpdir(), 'uimori-task-'));
  const inside = relative(resolve(tmpdir()), resolve(path));
  if (isAbsolute(inside) || inside.startsWith('..') || !basename(path).startsWith('uimori-task-'))
    throw new Error('Unsafe cleanup path');
  const app = await createApp({
    dbPath: join(path, 'story.sqlite'),
    buildId: 'task-receipt-test',
    testMode: true,
    codex: { enabled: false },
  });
  try {
    const store = app.store;
    const connection = store.product.connection({
      title: 'Synthetic model',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9',
      enabled: true,
    });
    const model = store.product.model({
      title: 'Synthetic model',
      connectionId: connection.id,
      modelId: 'fixture',
      temperature: null,
      maxOutputTokens: 1024,
    });
    const selected = modelWorkspace(store);
    updateModelWorkspace(store, {
      expectedRevision: selected.revision,
      routes: { ...selected.routes, main: { id: model.id } },
      translationPolicy: selected.translationPolicy,
      helperModel: { id: model.id },
      contextModel: { id: model.id },
    });
    const chat = createFixtureChat(store, '영수증 실패');
    const original = queuedRun(store, chat.id);
    store.finishRun(original.id, 'failed', 'synthetic failure');
    const workspace = new HelperWorkspace(store);
    const conversation = workspace.open({ kind: 'chat', chatId: chat.id });
    store.db.exec(`CREATE TEMP TRIGGER fail_task_receipt BEFORE INSERT ON helper_operations
      BEGIN SELECT RAISE(ABORT, 'RECEIPT_FAIL'); END`);
    const providerRoles: string[] = [];
    let index = 0;
    vi.spyOn(transport, 'executeProvider').mockImplementation(async (_connection, request) => {
      providerRoles.push(request.role);
      return index++ === 0
        ? {
            status: 'tool_calls',
            text: '',
            toolCalls: [
              {
                id: 'retry-one',
                name: 'app.call',
                arguments: { name: 'task.retry', arguments: { kind: 'run', id: original.id } },
              },
            ],
            refusal: null,
            error: null,
            usage: {
              inputTokens: 5,
              outputTokens: 3,
              costUsd: null,
              raw: null,
              priceRevision: null,
            },
            opaqueState: null,
          }
        : {
            status: 'completed',
            text: '재시도할 수 없었어요.',
            toolCalls: [],
            refusal: null,
            error: null,
            usage: {
              inputTokens: 5,
              outputTokens: 3,
              costUsd: null,
              raw: null,
              priceRevision: null,
            },
            opaqueState: null,
          };
    });
    const submitted = await app.inject({
      method: 'POST',
      url: `/api/helper/conversations/${conversation.id}/messages`,
      payload: { requestKey: 'failed-receipt', text: '실패한 본문 작업을 다시 시도해 줘.' },
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    const taskId = submitted.json().id as string;
    for (
      let poll = 0;
      poll < 100 && ['queued', 'running'].includes(workspace.task(taskId).status);
      poll++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(workspace.task(taskId)).toMatchObject({ status: 'failed', error: 'RECEIPT_FAIL' });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 1 });
    expect(store.run(original.id).status).toBe('failed');
    expect(providerRoles).toEqual(['helper']);
    expect(
      workspace.events(conversation.id).find((event) => event.kind === 'tool.finished')?.data
    ).toMatchObject({
      result: { recoverable: false, retryMode: 'inspect_outcome', outcome: 'unknown' },
    });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations').get()).toEqual({ n: 0 });
  } finally {
    await app.close();
    rmSync(path, { recursive: true, force: true });
  }
});

// Legacy host identity: keep matching events written before receipt inspection existed.
const receiptForCall = (taskId: string, callId: string) =>
  `${taskId}:${createHash('sha256').update(`${taskId}\0${callId}`).digest('hex')}`;

function receiptTask(f: ReturnType<typeof fixture>) {
  const conversation = f.workspace.open({ kind: 'library', workId: 'receipts' });
  const task = f.workspace.enqueue(conversation.id, randomUUID(), '저장 확인', {
    scope: conversation.scope,
    model: {} as never,
    history: [],
    persona: '',
    limits: { totalCalls: 3, helperCalls: 2, artifacts: 0 },
  });
  f.workspace.start(task.id, 'owner');
  return task;
}

test('helper inspection confirms durable effects even after a lost tool response, not from success events', () => {
  const f = fixture(),
    chat = createFixtureChat(f.store, '초기 제목'),
    task = receiptTask(f);
  const receiptId = receiptForCall(task.id, 'rename');
  const input = { name: 'chat.rename', args: { title: '저장된 제목' } };
  const first = f.workspace.operation(task.id, receiptId, input, () =>
    f.store.renameChat(chat.id, '저장된 제목', chat.titleRevision ?? 0)
  );
  expect(
    f.workspace.operation(task.id, receiptId, input, () => {
      throw new Error('must not replay');
    })
  ).toEqual(first);
  f.workspace.event(task.conversationId, task.id, 'tool.finished', {
    name: 'chat.rename',
    callId: 'rename',
    denied: false,
    result: first,
  });
  f.workspace.event(task.conversationId, task.id, 'tool.finished', {
    name: 'data.read',
    callId: 'read-only',
    denied: false,
    result: { text: 'PRIVATE_BODY' },
  });
  // Commit succeeded but the worker stopped before publishing tool.finished.
  const orphanId = receiptForCall(task.id, 'lost-response');
  f.workspace.operation(task.id, orphanId, { name: 'chat.rename' }, () =>
    f.store.renameChat(chat.id, '실제로 저장된 최종 제목', first.titleRevision ?? 0)
  );
  expect(() =>
    f.workspace.operation(task.id, 'rolled-back', {}, () => {
      f.store.renameChat(chat.id, '되돌려져야 하는 제목', f.store.chat(chat.id).titleRevision ?? 0);
      throw new Error('rollback');
    })
  ).toThrow('rollback');
  f.workspace.finish(task.id, 'owner', 1, 'failed', '', 'PROVIDER_EOF');
  const view = f.invoke('task.inspect', 'helper', task.id);
  expect(view).toMatchObject({
    status: 'failed',
    canRetry: false,
    retryBlock: 'HELPER_EFFECTS_ALREADY_COMMITTED',
    committedEffects: {
      total: 2,
      offset: 0,
      nextOffset: null,
      items: [
        { receiptId, committed: true, tool: 'chat.rename', callId: 'rename' },
        { receiptId: orphanId, committed: true, tool: null, callId: null },
      ],
    },
  });
  expect(JSON.stringify(view)).not.toContain('PRIVATE_BODY');
  expect(JSON.stringify(view)).not.toContain('실제로 저장된 최종 제목');
  expect(f.store.chat(chat.id).title).toBe('실제로 저장된 최종 제목');
  expect(
    f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations WHERE task_id=?').get(task.id)
      ?.n
  ).toBe(2);
});

test('committed effects stay paged and attributable after normal completed-input cleanup', () => {
  const f = fixture(),
    chat = createFixtureChat(f.store, '시작'),
    task = receiptTask(f);
  const expectedIds: string[] = [];
  for (let i = 0; i < 21; i++) {
    const callId = `rename-${i}`,
      receiptId = receiptForCall(task.id, callId);
    expectedIds.push(receiptId);
    const result = f.workspace.operation(task.id, receiptId, { name: 'chat.rename' }, () =>
      f.store.renameChat(chat.id, `SAVED_TITLE_${i}`, f.store.chat(chat.id).titleRevision ?? 0)
    );
    f.workspace.event(task.conversationId, task.id, 'tool.finished', {
      name: 'chat.rename',
      callId,
      denied: false,
      result,
    });
  }
  f.workspace.finish(task.id, 'owner', 1, 'completed', '완료', null);
  expect(
    JSON.stringify(
      f.store.db.prepare('SELECT result FROM helper_operations WHERE task_id=?').all(task.id)
    )
  ).not.toContain('SAVED_TITLE');
  const view = f.invoke('task.inspect', 'helper', task.id) as {
    committedEffects: {
      total: number;
      nextOffset: number | null;
      items: { receiptId: string; tool: string; callId: string }[];
    };
  };
  expect(view.committedEffects).toMatchObject({ total: 21, offset: 0, nextOffset: 20 });
  expect(view.committedEffects.items.map((item) => item.receiptId)).toEqual(
    expectedIds.slice(0, 20)
  );
  expect(
    view.committedEffects.items.every((item) => item.tool === 'chat.rename' && item.callId)
  ).toBe(true);
  const last = invokeTaskTool(
    f.store,
    f.current,
    'task.inspect',
    {
      kind: 'helper',
      id: task.id,
      effectsOffset: view.committedEffects.nextOffset,
    },
    'inspect',
    f.actions
  );
  expect(last).toMatchObject({
    committedEffects: {
      total: 21,
      offset: 20,
      nextOffset: null,
      items: [
        { receiptId: expectedIds[20], committed: true, tool: 'chat.rename', callId: 'rename-20' },
      ],
    },
  });
  expect(JSON.stringify(view)).not.toContain('SAVED_TITLE');
  expect(JSON.stringify(view).length).toBeLessThan(16000);
  const untouched = receiptTask(f);
  expect(f.invoke('task.inspect', 'helper', untouched.id)).toMatchObject({
    committedEffects: { total: 0, items: [], nextOffset: null },
  });
});
