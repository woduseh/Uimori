import { createApp, type App } from '../server/app.js';
import { describe } from 'vitest';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { Store } from '../server/store.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { HelperRuntime } from '../server/helper-runtime.js';
import { ResponseStreamStore } from '../server/response-stream.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { editableResource } from '../core/resource-editing.js';
import { readResource, saveResource } from '../server/resource-service.js';
import * as transport from '../core/transport.js';
import type { HelperTaskSnapshot } from '../core/helper.js';
import Fastify from 'fastify';
import { helperRoutes } from '../server/helper-routes.js';
import { HELPER_PERSONA_MAX_CHARS, REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { UI_HELPER_PERSONA } from '../web/helper-persona.js';
import { chatWithSource } from './fixtures/illustration.js';

const owned: { store: Store; path: string }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, path } of owned.splice(0)) {
    store.close();
    const inside = relative(tmpdir(), path);
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-helper-'))
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-helper-')),
    store = new Store(join(path, 'story.sqlite'));
  owned.push({ store, path });
  const connection = store.product.connection({
    title: 'Synthetic helper',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Synthetic helper',
    connectionId: connection.id,
    modelId: 'fixture-helper',
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
  const work: Promise<void>[] = [];
  const controller = new AbortController(),
    streams = new ResponseStreamStore(store);
  const runtime = new HelperRuntime(store, {
    owner: 'test-owner',
    signal: controller.signal,
    track: (p) => work.push(p),
    streams,
  });
  const workspace = runtime.workspace,
    conversation = workspace.open({ kind: 'library', workId: 'test' });
  return { store, runtime, workspace, conversation, work, controller, streams, model };
}
const success: transport.ProviderResult = {
  status: 'completed',
  text: '완료했어요.',
  toolCalls: [],
  refusal: null,
  error: null,
  usage: { inputTokens: 10, outputTokens: 4, costUsd: null, raw: null, priceRevision: null },
  opaqueState: null,
};

test('a native turn abort reaches pending helper context work and prevents its late save', async () => {
  const f = fixture();
  const connection = f.store.product.connection({
    title: 'Native helper',
    protocol: 'codex-app-server-v1',
    endpoint: 'codex://local',
    enabled: true,
  });
  const model = f.store.product.model({
    title: 'Native helper',
    connectionId: connection.id,
    modelId: 'synthetic-helper',
    temperature: null,
    maxOutputTokens: 1024,
  });
  const selected = modelWorkspace(f.store);
  updateModelWorkspace(f.store, {
    expectedRevision: selected.revision,
    routes: selected.routes,
    translationPolicy: selected.translationPolicy,
    helperModel: { id: model.id },
  });
  const nativeController = new AbortController();
  let enter!: (signal: AbortSignal) => void;
  let releaseLateResult!: () => void;
  let stopNative!: () => void;
  const entered = new Promise<AbortSignal>((resolve) => {
    enter = resolve;
  });
  const lateResult = new Promise<void>((resolve) => {
    releaseLateResult = resolve;
  });
  const nativeStopped = new Promise<void>((resolve) => {
    stopNative = resolve;
  });
  const save = vi.fn();
  let pendingTool: Promise<{ success: boolean; text: string }> | undefined;
  const runtime = new HelperRuntime(f.store, {
    owner: 'native-cancellation-test',
    signal: f.controller.signal,
    track: (work) => f.work.push(work),
    streams: f.streams,
    executeCodexAgent: async (_connection, _request, options) => {
      pendingTool = options.onToolCall(
        {
          callId: 'pending-context',
          name: 'app.call',
          arguments: { name: 'context.compact', arguments: { expectedRevision: 0 } },
        },
        nativeController.signal
      );
      await nativeStopped;
      return { ...success, status: 'error', text: '', error: { code: 'TIMEOUT' } };
    },
    services: {
      context: async (_task, _name, _args, hooks) => {
        enter(hooks.signal);
        await lateResult;
        hooks.signal.throwIfAborted();
        save();
        return { saved: true };
      },
    },
  });
  const chat = createFixtureChat(f.store, 'Native cancellation');
  const conversation = runtime.workspace.open({ kind: 'chat', chatId: chat.id });
  const task = runtime.enqueue(conversation.id, 'native-timeout', '문맥을 압축해줘.');
  const consumerSignal = await entered;
  nativeController.abort(new Error('Native turn timed out'));
  stopNative();
  await Promise.all(f.work);
  releaseLateResult();
  // Cancellation escapes the tool callback rather than becoming a recoverable result.
  await expect(pendingTool).rejects.toThrow('Native turn timed out');

  expect(f.controller.signal.aborted).toBe(false);
  expect(consumerSignal.aborted).toBe(true);
  expect(runtime.workspace.task(task.id)).toMatchObject({ status: 'failed', error: 'TIMEOUT' });
  expect(save).not.toHaveBeenCalled();
});

test('saved editor references freeze at admission and identical retries survive later saves and cleanup', async () => {
  const f = fixture();
  const saved = f.store.product.content(fixtureBotInput('접수할 자료', '원래 본문'));
  const editor = {
    kind: 'content' as const,
    source: 'saved' as const,
    targetId: saved.id,
    revision: saved.revision,
    title: saved.title,
  };
  let captured: transport.Json | undefined;
  const send = mockSend((request) => {
    captured = request.input.source;
    return structuredClone(success);
  });
  const task = f.runtime.enqueue(f.conversation.id, 'saved-reference', '내용을 설명해줘', editor);
  expect(task.snapshot.editor).toMatchObject({ ...editor, model: { text: '원래 본문' } });
  await Promise.all(f.work);
  expect(captured).toMatchObject({ editor: { hasUnsavedInput: false } });
  expect(f.workspace.task(task.id).snapshot.editor).toBeUndefined();
  const model = editableResource('content', readResource(f.store, 'content', saved.id));
  if (!('package' in model)) throw new Error('Expected content');
  model.package.nativeRisu!.card.description = '사용자가 나중에 고친 본문';
  const updated = saveResource(f.store, {
    kind: 'content',
    id: saved.id,
    expectedRevision: saved.revision,
    model,
  }).saved;
  expect(
    f.runtime.enqueue(f.conversation.id, 'saved-reference', '내용을 설명해줘', editor).id
  ).toBe(task.id);
  expect(() =>
    f.runtime.enqueue(f.conversation.id, 'saved-reference', '내용을 설명해줘', {
      ...editor,
      revision: updated.revision,
    })
  ).toThrow('같은 요청 키');
  expect(() =>
    f.runtime.enqueue(f.conversation.id, 'new-request', '내용을 설명해줘', editor)
  ).toThrow('참고하던 자료가 변경');
  expect(send).toHaveBeenCalledTimes(1);
});

test('an unsaved editor is analysis input and only mutations of that same resource are refused', async () => {
  const f = fixture();
  const saved = f.store.product.content(fixtureBotInput('편집 중인 자료'));
  const other = f.store.product.content(fixtureBotInput('다른 자료'));
  const draft = editableResource('content', readResource(f.store, 'content', saved.id));
  mockSend((_request, _options, index) => {
    if (index === 0)
      return {
        ...structuredClone(success),
        status: 'tool_calls',
        toolCalls: [saved, other].map((resource) => ({
          id: resource.id,
          name: 'app.call',
          arguments: {
            name: 'resource.patch',
            arguments: {
              kind: 'content',
              id: resource.id,
              expectedRevision: resource.revision,
              changes: [{ path: '/package/nativeRisu/card/name', op: 'set', value: '변경된 제목' }],
            },
          },
        })),
      };
    return structuredClone(success);
  });
  const task = f.runtime.enqueue(f.conversation.id, 'draft-target', '다른 자료의 제목을 바꿔줘', {
    kind: 'content',
    source: 'unsaved',
    targetId: saved.id,
    revision: saved.revision,
    title: saved.title,
    model: draft,
  });
  await Promise.all(f.work);
  expect(readResource(f.store, 'content', saved.id).revision).toBe(saved.revision);
  expect(readResource(f.store, 'content', other.id)).toMatchObject({
    title: '변경된 제목',
    revision: other.revision + 1,
  });
  expect(f.workspace.task(task.id).status).toBe('completed');
  expect(
    f.store.db
      .prepare('SELECT COUNT(*) AS count FROM helper_operations WHERE task_id=?')
      .get(task.id)?.count
  ).toBe(1);
  expect(() =>
    f.runtime.enqueue(f.conversation.id, 'draft-target', '다른 자료의 제목을 바꿔줘', {
      kind: 'content',
      source: 'unsaved',
      targetId: saved.id,
      revision: saved.revision,
      title: saved.title,
      model: { ...draft, description: '재전송하면서 바뀐 입력' },
    })
  ).toThrow('같은 요청 키');
});
function mockSend(
  action?: (
    request: transport.ProviderRequest,
    options: transport.ProviderExecutionOptions,
    index: number
  ) => Promise<transport.ProviderResult> | transport.ProviderResult
) {
  let index = 0;
  return vi
    .spyOn(transport, 'executeProvider')
    .mockImplementation(async (connection, request, options) => {
      // The mock stands in for the wire, not for the transport boundary contract.
      transport.validateConnection(connection);
      options.beforeTurn?.();
      await options.onWire?.({
        connectionId: connection.id,
        protocol: connection.protocol,
        role: request.role,
        modelId: request.modelId,
        method: 'POST',
        url: connection.endpoint,
        headers: {},
        body: request as unknown as transport.Json,
        bodySha256: 'synthetic',
        stablePrefixSha256: 'synthetic',
      });
      return action ? await action(request, options, index++) : structuredClone(success);
    });
}
function snapshot(f: ReturnType<typeof fixture>): HelperTaskSnapshot {
  return {
    scope: f.conversation.scope,
    model: f.store.product.modelSnapshot(f.model.id),
    history: [],
    persona: '',
    limits: { totalCalls: 24, helperCalls: 12, artifacts: 1 },
  };
}

test('live helper counters preserve attempt budgets and completion without loading the manuscript', () => {
  const f = fixture();
  const task = f.workspace.enqueue(f.conversation.id, 'live-state', '사용량 확인', {
    ...snapshot(f),
    history: [{ id: 'large-history', role: 'user', text: 'Reserved prose. '.repeat(350_000) }],
    limits: { totalCalls: 1, helperCalls: 1, artifacts: 1 },
  });
  const prepare = f.store.db.prepare.bind(f.store.db);
  const returnedRows: Record<string, unknown>[] = [];
  vi.spyOn(f.store.db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql);
    const get = statement.get.bind(statement);
    vi.spyOn(statement, 'get').mockImplementation((...args) => {
      const row = get(...args);
      if (row) returnedRows.push(row);
      return row;
    });
    return statement;
  });
  expect(f.workspace.start(task.id, 'counter-owner')).toBe(true);
  expect(f.workspace.taskState(task.id)).toMatchObject({
    status: 'running',
    generation: 1,
    usage: { modelCalls: 0 },
  });
  const wire = {
    connectionId: f.model.connectionId,
    protocol: 'fixture-sse-v1' as const,
    role: 'helper' as const,
    modelId: f.model.modelId,
    method: 'POST' as const,
    url: 'http://127.0.0.1:9',
    headers: {},
    body: {},
    bodySha256: 'synthetic',
    stablePrefixSha256: 'synthetic',
  };
  const attempt = f.workspace.startAttempt(task.id, 'counter-owner', 1, 'helper', 0, wire);
  expect(f.workspace.taskState(task.id).usage.modelCalls).toBe(1);
  expect(() => f.workspace.startAttempt(task.id, 'counter-owner', 1, 'helper', 0, wire)).toThrow(
    'MODEL_CALL_BUDGET_EXHAUSTED'
  );
  f.workspace.finishAttempt(task.id, attempt, success);
  f.workspace.finishAttempt(task.id, attempt, success);
  expect(f.workspace.taskState(task.id).usage).toEqual({
    modelCalls: 1,
    inputTokens: 10,
    outputTokens: 4,
    costUsd: null,
  });
  expect(f.workspace.finish(task.id, 'stale-owner', 1, 'completed', 'late', null)).toBe(false);
  expect(f.workspace.finish(task.id, 'counter-owner', 1, 'completed', 'done', null)).toBe(true);
  expect(f.workspace.taskState(task.id).status).toBe('completed');
  expect(returnedRows.every((row) => !('snapshot' in row))).toBe(true);
});

test('public helper task pages preserve summaries and receipts without loading reservations per row', async () => {
  const f = fixture();
  const app = Fastify();
  helperRoutes(app, f.runtime);
  const largeHistory = 'Private frozen helper history. '.repeat(2000);
  const ids: string[] = [];
  f.store.transaction(() => {
    for (let index = 0; index < 55; index++) {
      const task = f.workspace.enqueue(f.conversation.id, `page-${index}`, `요청 ${index}`, {
        ...snapshot(f),
        model: { ...f.store.product.modelSnapshot(f.model.id), title: `예약 당시 모델 ${index}` },
        history: [{ id: 'frozen-message', role: 'user', text: largeHistory }],
      });
      ids.push(task.id);
      f.workspace.start(task.id, 'page-owner');
      if (index % 2 === 0) {
        f.workspace.operation(task.id, `saved-${index}`, {}, () => ({ saved: true }));
        f.workspace.operation(task.id, `saved-again-${index}`, {}, () => ({ saved: true }));
      } else {
        f.workspace.event(f.conversation.id, task.id, 'tool.finished', { saved: true });
      }
      f.store.db.prepare("UPDATE helper_tasks SET status='completed' WHERE id=?").run(task.id);
    }
    ids.forEach((id, index) => {
      const status =
        index === 54
          ? 'running'
          : ['queued', 'completed', 'failed', 'cancelled', 'interrupted'][index % 5];
      f.store.db
        .prepare('UPDATE helper_tasks SET status=?,error=?,created_at=?,started_at=? WHERE id=?')
        .run(
          status,
          status === 'failed' ? 'UNEXPECTED_EOF' : null,
          `2030-01-01T00:00:${String(59 - index).padStart(2, '0')}.000Z`,
          status === 'queued' ? null : '2030-01-01T00:01:00.000Z',
          id
        );
    });
  });
  const other = f.workspace.create(f.conversation.scope, 'other-page');
  const otherTask = f.workspace.enqueue(other.id, 'other', '다른 대화', snapshot(f));
  const project = (task: ReturnType<typeof f.workspace.task>) => {
    const { snapshot: reserved, ...view } = task;
    return { ...view, modelTitle: reserved.model.title };
  };
  const expected = ids
    .slice(-50)
    .reverse()
    .map((id) => project(f.workspace.task(id)));
  const before = expected.at(-1)!.id;
  const expectedOlder = ids
    .slice(0, 5)
    .reverse()
    .map((id) => project(f.workspace.task(id)));
  expect(expected.map((task) => task.id)).toEqual(ids.slice(-50).reverse());
  expect(expectedOlder.map((task) => task.id)).toEqual(ids.slice(0, 5).reverse());

  const prepare = f.store.db.prepare.bind(f.store.db);
  const returnedRows: Record<string, unknown>[] = [];
  const queries = vi.spyOn(f.store.db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql);
    const all = statement.all.bind(statement);
    vi.spyOn(statement, 'all').mockImplementation((...args) => {
      const rows = all(...args);
      returnedRows.push(...rows);
      return rows;
    });
    return statement;
  });
  try {
    const page = await app.inject({
      url: `/api/helper/conversations/${f.conversation.id}/tasks`,
    });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toEqual(expected);
    expect(queries.mock.calls.length).toBeLessThanOrEqual(3);
    expect(returnedRows).toHaveLength(50);
    expect(returnedRows.every((row) => !('snapshot' in row))).toBe(true);
    expect(JSON.stringify(returnedRows)).not.toContain(largeHistory);
    for (const task of page.json()) {
      const index = ids.indexOf(task.id);
      if (['failed', 'cancelled', 'interrupted'].includes(task.status) && index % 2 === 0)
        expect(task.completedEffects).toEqual({ count: 2, labels: ['완료된 도우미 작업'] });
      else expect(task).not.toHaveProperty('completedEffects');
    }

    const older = await app.inject({
      url: `/api/helper/conversations/${f.conversation.id}/tasks?before=${before}`,
    });
    expect(older.json()).toEqual(expectedOlder);
    const view = await app.inject({
      url: `/api/helper/conversations/${f.conversation.id}/view`,
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().tasks).toEqual(expected);
    const failed = expected.find((task) => task.completedEffects)!;
    const detail = await app.inject({ url: `/api/helper/tasks/${failed.id}` });
    expect(detail.json()).toEqual(failed);
    for (const cursor of ['missing-task', otherTask.id]) {
      const outside = await app.inject({
        url: `/api/helper/conversations/${f.conversation.id}/tasks?before=${cursor}`,
      });
      expect(outside.json()).toEqual([]);
    }
    for (const url of [
      '/api/helper/conversations/missing-conversation/tasks',
      '/api/helper/conversations/missing-conversation/view',
      '/api/helper/tasks/missing-task',
    ]) {
      expect((await app.inject({ url })).statusCode).toBe(404);
    }
    expect(f.workspace.task(ids[0]).snapshot.history[0].text).toBe(largeHistory);
  } finally {
    await app.close();
  }
});

test('library-only helper has durable attempts, idempotent submission and no main run', async () => {
  const f = fixture(),
    send = mockSend();
  const task = f.runtime.enqueue(f.conversation.id, 'same-request', '작품에 관해 설명해줘');
  await Promise.all(f.work);
  const again = f.runtime.enqueue(f.conversation.id, 'same-request', '작품에 관해 설명해줘');
  expect(again.id).toBe(task.id);
  expect(send).toHaveBeenCalledTimes(1);
  expect(f.workspace.task(task.id)).toMatchObject({
    status: 'completed',
    usage: { modelCalls: 1, costUsd: null },
  });
  expect(f.store.db.prepare('SELECT chat_id,run_id FROM attempts').get()).toEqual({
    chat_id: null,
    run_id: null,
  });
  expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
  expect(f.workspace.messages(f.conversation.id).map((item) => item.role)).toEqual([
    'user',
    'assistant',
  ]);
  expect(() => f.runtime.enqueue(f.conversation.id, 'same-request', '다른 요청')).toThrow(
    '같은 요청 키'
  );
});

test('real transport executes requested outline writing without generating prose', async () => {
  const f = fixture(),
    chat = createFixtureChat(f.store, '구성만 요청한 본편');
  const conversation = f.workspace.open({
    kind: 'chat',
    chatId: chat.id,
  });
  const bodies: transport.ProviderRequest[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    expect(new URL(String(url)).origin).toBe('http://127.0.0.1:9');
    expect(options?.method).toBe('POST');
    const body = JSON.parse(String(options?.body)) as transport.ProviderRequest;
    bodies.push(body);
    expect(body.role).toBe('helper');
    const events =
      bodies.length === 1
        ? [
            {
              type: 'tool_delta',
              index: 0,
              id: 'outline',
              name: 'outline.write',
              argumentsDelta: JSON.stringify({
                operations: [{ op: 'create', level: 'theme', title: '계획만 저장', intent: '' }],
              }),
            },
            { type: 'done', reason: 'tool_calls' },
          ]
        : [
            { type: 'text_delta', delta: '구성을 저장했어요.' },
            { type: 'done', reason: 'stop' },
          ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const task = f.runtime.enqueue(conversation.id, 'outline-only', '장면의 구성만 만들어줘');
  await Promise.all(f.work);
  expect(f.workspace.task(task.id), f.workspace.task(task.id).error ?? '').toMatchObject({
    status: 'completed',
    usage: { modelCalls: 2 },
  });
  expect(bodies).toHaveLength(2);
  const events = bodies[1].input.results as unknown as import('../core/types.js').ToolEvent[];
  expect(events.find((event) => event.name === 'outline.write')).toMatchObject({ denied: false });
  expect(events.some((event) => event.name === 'artifact.generate')).toBe(false);
  expect(f.store.outline.detail(chat.id).nodes.map((node) => node.title)).toEqual(['계획만 저장']);
  expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_artifact_jobs').get()).toEqual({
    n: 0,
  });
  expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
  expect(f.store.product.attempts(chat.id)).toMatchObject([
    { role: 'helper', status: 'tool_calls' },
    { role: 'helper', status: 'completed' },
  ]);
});
test('operation receipt and nested service mutation commit or roll back together', () => {
  const f = fixture(),
    chat = createFixtureChat(f.store, '원 제목');
  const task = f.workspace.enqueue(f.conversation.id, 'r', 'rename', snapshot(f));
  f.workspace.start(task.id, 'owner');
  const apply = () => f.store.renameChat(chat.id, '바뀐 제목', chat.titleRevision ?? 0);
  const first = f.workspace.operation(task.id, 'stable-op', { title: '바뀐 제목' }, apply);
  const again = f.workspace.operation(task.id, 'stable-op', { title: '바뀐 제목' }, () => {
    throw new Error('must not repeat');
  });
  expect(again).toEqual(first);
  expect(() =>
    f.workspace.operation(task.id, 'failed-op', { title: 'bad' }, () => {
      f.store.renameChat(chat.id, '취소할 제목', first.titleRevision ?? 0);
      throw new Error('rollback');
    })
  ).toThrow('rollback');
  expect(f.store.chat(chat.id).title).toBe('바뀐 제목');
  expect(
    f.store.db.prepare('SELECT id FROM helper_operations WHERE id=?').get('failed-op')
  ).toBeUndefined();
  expect(() => f.workspace.operation(task.id, 'stable-op', { title: 'different' }, apply)).toThrow(
    'OPERATION_ID_CONFLICT'
  );
});

test('a saved change survives an explanation EOF and prevents whole-request retry after reopening the database', async () => {
  const f = fixture(),
    chat = createFixtureChat(f.store, '원 제목');
  const conversation = f.workspace.open({
    kind: 'chat',
    chatId: chat.id,
  });
  const send = mockSend((_request, _options, index) =>
    index === 0
      ? {
          ...structuredClone(success),
          status: 'tool_calls',
          text: '',
          toolCalls: [
            {
              id: 'rename',
              name: 'chat.rename',
              arguments: {
                title: '저장 완료',
                expectedRevision: chat.titleRevision ?? 0,
              },
            },
          ],
        }
      : {
          ...structuredClone(success),
          status: 'error',
          text: '',
          error: { code: 'UNEXPECTED_EOF' },
        }
  );
  const task = f.runtime.enqueue(conversation.id, 'rename-eof', '제목을 바꿔줘');
  await Promise.all(f.work);
  expect(f.store.chat(chat.id).title).toBe('저장 완료');
  expect(f.workspace.task(task.id)).toMatchObject({
    status: 'failed',
    error: 'UNEXPECTED_EOF',
    completedEffects: { count: 1, labels: ['완료된 도우미 작업'] },
  });
  expect(send).toHaveBeenCalledTimes(2);
  const owner = owned.find((item) => item.store === f.store)!;
  f.store.close();
  owner.store = new Store(join(owner.path, 'story.sqlite'));
  const reopened = new HelperWorkspace(owner.store);
  const previous = reopened.task(task.id);
  expect(previous.completedEffects).toEqual({ count: 1, labels: ['완료된 도우미 작업'] });
  expect(() =>
    reopened.enqueue(conversation.id, 'retry-eof', previous.request, {
      ...previous.snapshot,
      retryOf: previous.id,
    })
  ).toThrow('HELPER_EFFECTS_ALREADY_COMMITTED');
  expect(reopened.taskSummaries(conversation.id)).toHaveLength(1);
});

test('a rolled-back operation does not block retry or claim a completed change', () => {
  const f = fixture(),
    chat = createFixtureChat(f.store, '원 제목');
  const task = f.workspace.enqueue(f.conversation.id, 'rollback', 'rename', snapshot(f));
  f.workspace.start(task.id, 'owner');
  expect(() =>
    f.workspace.operation(task.id, 'rolled-back', {}, () => {
      f.store.renameChat(chat.id, '되돌릴 제목', chat.titleRevision ?? 0);
      throw new Error('rolled back');
    })
  ).toThrow('rolled back');
  f.workspace.finish(task.id, 'owner', 1, 'failed', '', 'UNEXPECTED_EOF');
  expect(f.workspace.task(task.id)).not.toHaveProperty('completedEffects');
  expect(f.store.chat(chat.id).title).toBe('원 제목');
  expect(
    f.workspace.enqueue(f.conversation.id, 'retry', 'rename', {
      ...snapshot(f),
      retryOf: task.id,
    }).snapshot.retryOf
  ).toBe(task.id);
});

test('cancellation rejects late text/final result while preserving provider accounting', async () => {
  const f = fixture();
  let release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  mockSend(async (_request, options) => {
    await options.onProgress?.({ text: '받은 부분', offset: 5 });
    await barrier;
    await options.onProgress?.({ text: '늦은 부분', offset: 10 });
    return structuredClone(success);
  });
  const task = f.runtime.enqueue(f.conversation.id, 'r', '설명해줘');
  await vi.waitFor(() =>
    expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 1 })
  );
  f.runtime.cancel(task.id);
  release();
  await Promise.all(f.work);
  expect(f.workspace.task(task.id).status).toBe('cancelled');
  expect(f.workspace.task(task.id).usage.modelCalls).toBe(1);
  expect(
    f.workspace.messages(f.conversation.id).filter((message) => message.role === 'assistant')
  ).toHaveLength(0);
  const stream = f.streams.read('helper', task.id);
  expect(stream.status).toBe('cancelled');
  expect(stream.chunks.map((chunk) => chunk.text).join('')).not.toContain('늦은 부분');
});
test('server recovery interrupts queued work and never calls a provider', () => {
  const f = fixture(),
    send = mockSend();
  const task = f.workspace.enqueue(f.conversation.id, 'r', '설명해줘', snapshot(f));
  new HelperWorkspace(f.store).interrupt();
  expect(f.workspace.task(task.id).status).toBe('interrupted');
  expect(send).not.toHaveBeenCalled();
});

test('follow-up requests queue durably and start with the completed preceding exchange', async () => {
  const f = fixture();
  let release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: transport.ProviderRequest[] = [];
  mockSend(async (request, _options, index) => {
    calls.push(structuredClone(request));
    if (index === 0) await barrier;
    return { ...success, text: index === 0 ? '첫 답변' : '둘째 답변' };
  });
  const first = f.runtime.enqueue(f.conversation.id, 'q1', '첫 질문');
  const second = f.runtime.enqueue(f.conversation.id, 'q2', '둘째 질문');
  expect(f.workspace.task(first.id).status).toBe('running');
  expect(f.workspace.task(second.id).status).toBe('queued');
  release();
  await vi.waitFor(() => expect(f.workspace.task(second.id).status).toBe('completed'));
  await Promise.all(f.work);
  expect(calls).toHaveLength(2);
  expect(calls[1].input.history).toEqual([
    expect.objectContaining({ role: 'user', text: '첫 질문' }),
    expect.objectContaining({ role: 'assistant', text: '첫 답변' }),
  ]);
  expect(f.workspace.task(second.id).usage.modelCalls).toBe(1);
});

test('helper retries retain attempts but project the latest response at the original request position', async () => {
  const f = fixture();
  mockSend((_request, _options, index) =>
    index < 2
      ? { ...structuredClone(success), status: 'error', text: '', error: { code: 'HTTP_429' } }
      : structuredClone(success)
  );
  const first = f.runtime.enqueue(f.conversation.id, 'attempt-1', '원래 요청');
  await Promise.all(f.work);
  const second = f.runtime.enqueue(
    f.conversation.id,
    'attempt-2',
    '수정한 요청',
    undefined,
    undefined,
    first.id
  );
  await Promise.all(f.work);
  const third = f.runtime.enqueue(
    f.conversation.id,
    'attempt-3',
    '수정한 요청',
    undefined,
    undefined,
    second.id
  );
  await Promise.all(f.work);
  expect(f.workspace.task(third.id).status).toBe('completed');
  expect(
    f.runtime.enqueue(
      f.conversation.id,
      'attempt-3',
      '수정한 요청',
      undefined,
      undefined,
      second.id
    ).id
  ).toBe(third.id);
  expect(() =>
    f.runtime.enqueue(f.conversation.id, 'stale', '원래 요청', undefined, undefined, first.id)
  ).toThrow('이미 다시 시도');
  expect(() =>
    f.runtime.enqueue(f.conversation.id, 'attempt-3', '수정한 요청', undefined, undefined, first.id)
  ).toThrow('같은 요청 키');
  const reloaded = new HelperWorkspace(f.store);
  const messages = reloaded.messages(f.conversation.id);
  const visible = messages.filter((message) => message.latestTaskId === message.taskId);
  expect(visible.map((message) => message.role)).toEqual(['user', 'assistant']);
  expect(visible[0].text).toBe('수정한 요청');
  expect(visible[0].requestGroupId).toBe(first.id);
  expect(visible[0].requestOrder).toBe(messages[0].requestOrder);
  expect(reloaded.taskSummaries(f.conversation.id)).toHaveLength(3);
  expect(reloaded.task(first.id).status).toBe('failed');
});

test('only unnamed new sessions adopt the first request title and preserve explicit or renamed titles', () => {
  const f = fixture(),
    question = `  첫 질문\n${'🌟'.repeat(90)}`;
  const task = f.workspace.enqueue(f.conversation.id, 'first', question, snapshot(f));
  const expected = Array.from(question.trim().replace(/\s+/gu, ' ')).slice(0, 80).join('');
  expect(f.workspace.conversation(f.conversation.id)).toMatchObject({
    title: expected,
    revision: 2,
  });
  expect(f.workspace.open(f.conversation.scope).title).toBe(expected);
  expect(f.workspace.existing(f.conversation.id, 'first', question)?.id).toBe(task.id);
  f.workspace.enqueue(f.conversation.id, 'second', '두 번째 요청', snapshot(f));
  expect(f.workspace.conversation(f.conversation.id).title).toBe(expected);
  const explicit = f.workspace.create(f.conversation.scope, 'explicit', '새 도우미 대화');
  f.workspace.enqueue(explicit.id, 'first', '이 요청은 이름이 되면 안 돼요', snapshot(f));
  expect(f.workspace.conversation(explicit.id).title).toBe('새 도우미 대화');
  const manual = f.workspace.create(f.conversation.scope, 'manual');
  f.workspace.update(manual.id, manual.revision, { title: '내가 정한 이름' });
  f.workspace.enqueue(manual.id, 'first', '이 요청도 이름이 되면 안 돼요', snapshot(f));
  expect(f.workspace.conversation(manual.id).title).toBe('내가 정한 이름');
});

test('all helper sessions share two execution slots while each session preserves FIFO and isolated history', async () => {
  const f = fixture();
  const a = f.conversation,
    b = f.workspace.create(a.scope, 'b'),
    c = f.workspace.create(a.scope, 'c'),
    empty = f.workspace.create(a.scope, 'empty');
  const releases = new Map<string, () => void>();
  const calls: string[] = [];
  const histories = new Map<string, string[]>();
  let live = 0,
    peak = 0;
  mockSend(async (request) => {
    const name = String(request.input.task);
    calls.push(name);
    const activeTask = f.workspace
      .taskSummaries(name.startsWith('A') ? a.id : name.startsWith('B') ? b.id : c.id)
      .find((task) => task.status === 'running')!;
    histories.set(
      name,
      f.workspace.task(activeTask.id).snapshot.history.map((message) => message.text)
    );
    live++;
    peak = Math.max(peak, live);
    await new Promise<void>((resolve) => releases.set(name, resolve));
    live--;
    return { ...success, text: `${name} 답변` };
  });
  const a1 = f.runtime.enqueue(a.id, 'a1', 'A1');
  const a2 = f.runtime.enqueue(a.id, 'a2', 'A2');
  const b1 = f.runtime.enqueue(b.id, 'b1', 'B1');
  const c1 = f.runtime.enqueue(c.id, 'c1', 'C1');
  await vi.waitFor(() => expect(calls).toEqual(['A1', 'B1']));
  expect(f.workspace.task(a2.id).status).toBe('queued');
  expect(f.workspace.task(c1.id).status).toBe('queued');
  expect(f.workspace.list({ kind: 'library' }).find((item) => item.id === a.id)?.activity).toEqual({
    running: 1,
    queued: 1,
  });
  expect(f.workspace.list({ kind: 'library' }).find((item) => item.id === empty.id)).toMatchObject({
    activity: { running: 0, queued: 0 },
    latestEventSeq: 0,
  });
  for (const session of f.workspace.list({ kind: 'library' }))
    expect(session.latestEventSeq).toBe(f.workspace.latestEventSequence(session.id));
  releases.get('B1')!();
  await vi.waitFor(() => expect(calls).toEqual(['A1', 'B1', 'C1']));
  expect(f.workspace.task(a2.id).status).toBe('queued');
  releases.get('A1')!();
  await vi.waitFor(() => expect(calls).toEqual(['A1', 'B1', 'C1', 'A2']));
  releases.get('C1')!();
  releases.get('A2')!();
  await vi.waitFor(() => expect(f.workspace.task(a2.id).status).toBe('completed'));
  await Promise.all(f.work);
  expect(peak).toBe(2);
  expect(histories.get('A2')).toEqual(['A1', 'A1 답변']);
  expect(histories.get('C1')).toEqual([]);
  expect(f.workspace.task(a2.id).snapshot.history).toEqual([]);
  expect([a1, a2, b1, c1].map((task) => f.workspace.task(task.id).status)).toEqual([
    'completed',
    'completed',
    'completed',
    'completed',
  ]);
});

test('the helper persona is bounded, saved per conversation and reaches only the helper contract', async () => {
  const f = fixture();
  const calls: transport.ProviderRequest[] = [];
  mockSend((request) => {
    calls.push(structuredClone(request));
    return success;
  });
  const app = Fastify();
  helperRoutes(app, f.runtime);
  const patch = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/helper/conversations/${f.conversation.id}`,
      payload,
    });
  try {
    const before = f.workspace.conversation(f.conversation.id);
    const over = await patch({
      expectedRevision: before.revision,
      persona: '우'.repeat(HELPER_PERSONA_MAX_CHARS + 1),
    });
    expect(over.statusCode).toBe(400);
    expect(f.workspace.conversation(f.conversation.id)).toEqual(before);
    const saved = await patch({
      expectedRevision: before.revision,
      persona: UI_HELPER_PERSONA,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().persona).toBe(UI_HELPER_PERSONA);
  } finally {
    await app.close();
  }
  const other = f.workspace.open({ kind: 'library', workId: 'other' });
  expect(other.persona).toBe('');
  f.runtime.enqueue(f.conversation.id, 'with-persona', '이 설정을 설명해줘');
  f.runtime.enqueue(other.id, 'without-persona', '이 설정을 설명해줘');
  await Promise.all(f.work);
  expect(calls).toHaveLength(2);
  expect(calls.every((call) => call.role === 'helper')).toBe(true);
  expect(calls[0].stable.contract).toContain(UI_HELPER_PERSONA);
  expect(calls[1].stable.contract).not.toContain(UI_HELPER_PERSONA);
});

test('selected prose appears once in the current request and survives into the next helper turn', async () => {
  const f = fixture();
  const { source } = chatWithSource(f.store);
  const selectedText = 'selected source sentence.\n'.repeat(5200) + 'THE_EXACT_END';
  const current = f.store.editSource(source.id, { text: selectedText, expectedRevision: 0 });
  const conversation = f.workspace.open({
    kind: 'chat',
    chatId: source.chatId,
  });
  const calls: transport.ProviderRequest[] = [];
  mockSend((request) => {
    calls.push(structuredClone(request));
    return success;
  });
  const request = 'Keep this exact user request.';
  const selection = { sourceId: source.id, sourceHash: current.hash, text: selectedText };
  const first = f.runtime.enqueue(
    conversation.id,
    'selected-passage',
    request,
    undefined,
    selection
  );
  await Promise.all(f.work);
  expect(f.workspace.task(first.id)).toMatchObject({ status: 'completed', request });
  expect(f.workspace.task(first.id).snapshot.selection).toBeUndefined();
  expect(calls[0].input.task).toBe(request);
  expect(calls[0].input.history).toEqual([]);
  expect(calls[0].input.source).toMatchObject({ selection });
  expect(JSON.stringify(calls[0].input).split('THE_EXACT_END')).toHaveLength(2);
  expect(
    f.workspace.messages(conversation.id).find((message) => message.role === 'user')?.text
  ).toBe(request);
  const next = f.runtime.enqueue(
    conversation.id,
    'selection-follow-up',
    'Now explain the final sentence.'
  );
  await Promise.all(f.work);
  expect(f.workspace.task(next.id).status).toBe('completed');
  expect(calls).toHaveLength(2);
  const history = calls[1].input.history as { role: string; text: string }[];
  expect(history[0].text).toContain(source.id);
  expect(history[0].text).toContain(current.hash);
  expect(history[0].text.endsWith(selectedText)).toBe(true);
});

test('the helper message route preserves full-length Korean requests and selected source text', async () => {
  const f = fixture();
  // This check reserves real SQLite work without dispatching a model request.
  f.controller.abort();
  const { source } = chatWithSource(f.store);
  const selectedText = '가'.repeat(REQUEST_TEXT_MAX_CHARS - 1) + '끝';
  const current = f.store.editSource(source.id, { text: selectedText, expectedRevision: 0 });
  const conversation = f.workspace.open({
    kind: 'chat',
    chatId: source.chatId,
  });
  const message = '나'.repeat(REQUEST_TEXT_MAX_CHARS - 1) + '끝';
  const selection = { sourceId: source.id, sourceHash: current.hash, text: selectedText };
  const app = Fastify({ bodyLimit: 4 * 1024 * 1024 });
  helperRoutes(app, f.runtime);
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/api/helper/conversations/${conversation.id}/messages`,
      payload: { requestKey: 'full-length-selection', text: message, selection },
    });
    expect(response.statusCode, response.body.slice(0, 300)).toBe(200);
    const task = f.workspace.task(response.json().id);
    expect(task.request).toBe(message);
    expect(task.snapshot.selection).toEqual(selection);
    const over = await app.inject({
      method: 'POST',
      url: `/api/helper/conversations/${conversation.id}/messages`,
      payload: {
        requestKey: 'over-length-selection',
        text: '검토',
        selection: { ...selection, text: selectedText + '넘침' },
      },
    });
    expect(over.statusCode).toBe(400);
    expect(f.workspace.taskSummaries(conversation.id)).toHaveLength(1);
  } finally {
    await app.close();
  }
});

describe('Helper current view cursor', () => {
  const owners: { directory: string; store: Store; app?: App }[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const owner of owners.splice(0)) {
      if (owner.app) await owner.app.close();
      else owner.store.close();
      rmSync(owner.directory, { recursive: true, force: true });
    }
  });

  async function application() {
    const directory = mkdtempSync(join(tmpdir(), 'uimori-retention-'));
    const app = await createApp({
      dbPath: join(directory, 'app.sqlite'),
      buildId: 'extended-cleanup-test',
      testMode: true,
      codex: { enabled: false },
    });
    owners.push({ directory, store: app.store, app });
    return app;
  }

  test('helper opening returns current state and a cursor beyond old update pages', async () => {
    const app = await application();
    const workspace = new HelperWorkspace(app.store);
    const conversation = workspace.create({ kind: 'library', workId: 'synthetic' }, 'open');
    app.store.transaction(() => {
      for (let i = 0; i < 1200; i++) workspace.event(conversation.id, null, 'conversation.updated');
    });
    const response = await app.inject({ url: `/api/helper/conversations/${conversation.id}/view` });
    expect(response.statusCode).toBe(200);
    const view = response.json();
    expect(view.eventCursor).toBe(workspace.latestEventSequence(conversation.id));
    expect(view.messages).toEqual([]);
    expect(workspace.events(conversation.id, view.eventCursor)).toEqual([]);
    workspace.event(conversation.id, null, 'theme.updated');
    expect(workspace.events(conversation.id, view.eventCursor).map((event) => event.kind)).toEqual([
      'theme.updated',
    ]);
  });
});

test('selected outline review allows evidence reads, rejects writes and retains only small review provenance', async () => {
  const f = fixture(),
    { chat, source } = chatWithSource(f.store, '원문 점검');
  const node = f.store.outline.apply(
    chat.id,
    {
      idempotencyKey: 'review-plan',
      operations: [
        { op: 'create', level: 'episode', title: '조용한 부두', intent: '미라가 배를 기다린다.' },
      ],
    },
    'user'
  ).detail.nodes[0];
  f.store.db
    .prepare('INSERT INTO outline_writings(id,node_id,source_id,created_at) VALUES(?,?,?,?)')
    .run('test-source', node.id, source.id, new Date().toISOString());
  const conversation = f.workspace.open({
    kind: 'chat',
    chatId: chat.id,
  });
  const requests: transport.ProviderRequest[] = [];
  mockSend((request, _options, index): transport.ProviderResult => {
    requests.push(request);
    expect(request.stable.tools.map((tool) => tool.name)).toEqual([
      'data.search',
      'data.read',
      'db.query',
      'app.tools',
      'app.call',
    ]);
    if (index === 0)
      return {
        ...structuredClone(success),
        status: 'tool_calls',
        text: '',
        toolCalls: [
          {
            id: 'read-evidence',
            name: 'data.search',
            arguments: { scope: 'current', ids: [source.id], patterns: ['Mira'] },
          },
          { id: 'discover-outline', name: 'app.tools', arguments: {} },
          {
            id: 'read-outline',
            name: 'app.call',
            arguments: { name: 'outline.read', arguments: { mode: 'detail', nodeId: node.id } },
          },
          {
            id: 'forbidden-save',
            name: 'app.call',
            arguments: {
              name: 'outline.write',
              arguments: {
                operations: [
                  {
                    op: 'update',
                    id: node.id,
                    expectedRevision: node.revision,
                    intent: '무단 변경',
                  },
                ],
              },
            },
          },
        ],
      };
    return {
      ...structuredClone(success),
      text: `현재 원문의 ${source.id}에서 “Mira waited on the pier.”를 확인했어요.`,
    };
  });
  const target = { nodeId: node.id, expectedRevision: node.revision, purpose: 'review' as const };
  const task = f.runtime.enqueue(
    conversation.id,
    'review-selected',
    '원문과 비교만 해줘',
    undefined,
    undefined,
    undefined,
    target
  );
  await Promise.all(f.work);
  const input = (
    requests[0].input.source as unknown as {
      outline: import('../core/outline.js').OutlineHelperContext;
    }
  ).outline;
  expect(input.sources).toEqual([
    {
      id: source.id,
      hash: source.hash,
      start: 0,
      end: source.text.length,
      total: source.text.length,
      text: source.text,
    },
  ]);
  expect(input.partial).toBe(false);
  expect(requests[1].input.results).toMatchObject([
    { name: 'data.search', denied: false },
    { name: 'app.tools', denied: false },
    {
      name: 'app.call',
      denied: false,
      result: { text: node.intent, coverage: { content: 'intent-range', wholeField: true } },
    },
    { denied: true, result: { error: 'OUTLINE_REVIEW_READ_ONLY' } },
  ]);
  const catalog = (requests[1].input.results as any[])[1].result;
  expect(catalog.tools.some((tool: any) => tool.name === 'outline.read')).toBe(true);
  expect(catalog.tools.some((tool: any) => tool.name === 'outline.write')).toBe(false);
  expect(JSON.stringify(requests[1].input.results)).toContain('Mira waited on the pier.');
  expect(f.store.outline.node(node.id).intent).toBe(node.intent);
  expect(f.workspace.task(task.id).status).toBe('completed');
  expect(f.workspace.task(task.id).snapshot.outline).toBeUndefined();
  expect(f.store.outline.latestReview(node.id)).toMatchObject({
    taskId: task.id,
    status: 'completed',
    stale: false,
    partial: false,
  });
  expect(
    f.runtime.enqueue(
      conversation.id,
      'review-selected',
      '원문과 비교만 해줘',
      undefined,
      undefined,
      undefined,
      target
    ).id
  ).toBe(task.id);
  expect(requests).toHaveLength(2);
  const sibling = f.store.outline.applyReceipt(
    chat.id,
    {
      idempotencyKey: 'review-unrelated',
      operations: [{ op: 'create', level: 'arc', title: '관계없는 부', intent: '별개 계획' }],
    },
    'user'
  ).created[0].id;
  expect(f.store.outline.latestReview(node.id)?.stale).toBe(false);
  f.store.outline.applyReceipt(
    chat.id,
    {
      idempotencyKey: 'review-unrelated-edit',
      operations: [{ op: 'update', id: sibling, expectedRevision: 1, intent: '별개 계획 수정' }],
    },
    'user'
  );
  expect(f.store.outline.latestReview(node.id)?.stale).toBe(false);
  const { editSource } = await import('../server/source-editing.js');
  editSource(f.store, source.id, {
    expectedRevision: source.editRevision,
    text: 'Mira had already left the pier.',
  });
  expect(f.store.outline.latestReview(node.id)?.stale).toBe(true);
  const row = f.store.db
    .prepare('SELECT sources FROM outline_reviews WHERE task_id=?')
    .get(task.id);
  expect(JSON.stringify(row)).not.toContain(source.text);
  expect(
    f.store.db.prepare('SELECT count(*) AS n FROM helper_operations WHERE task_id=?').get(task.id)
      ?.n
  ).toBe(0);
});

test('outline selection scope and revisions are checked before a provider call; a requested keep-condition edit uses the real helper path', async () => {
  const f = fixture(),
    chat = createFixtureChat(f.store, '선택 대상'),
    other = createFixtureChat(f.store, '다른 작품');
  const node = f.store.outline.apply(
    chat.id,
    {
      idempotencyKey: 'one',
      operations: [{ op: 'create', level: 'episode', title: '같은 제목', intent: '원래 방향' }],
    },
    'user'
  ).detail.nodes[0];
  f.store.outline.apply(
    chat.id,
    {
      idempotencyKey: 'pin',
      operations: [{ op: 'update', id: node.id, expectedRevision: node.revision, fixed: true }],
    },
    'user'
  );
  const pinned = f.store.outline.node(node.id);
  const conversation = f.workspace.open({
    kind: 'chat',
    chatId: chat.id,
  });
  const foreign = f.store.outline.apply(
    other.id,
    {
      idempotencyKey: 'other',
      operations: [{ op: 'create', level: 'episode', title: '같은 제목', intent: '' }],
    },
    'user'
  ).detail.nodes[0];
  const send = mockSend((_request, _options, index) =>
    index === 0
      ? {
          ...structuredClone(success),
          status: 'tool_calls',
          text: '',
          toolCalls: [
            {
              id: 'change-condition',
              name: 'app.call',
              arguments: {
                name: 'outline.write',
                arguments: {
                  operations: [
                    {
                      op: 'update',
                      id: pinned.id,
                      expectedRevision: pinned.revision,
                      intent: '명시 요청으로 변경한 결말',
                    },
                  ],
                },
              },
            },
          ],
        }
      : structuredClone(success)
  );
  expect(() =>
    f.runtime.enqueue(conversation.id, 'wrong', '변경', undefined, undefined, undefined, {
      nodeId: foreign.id,
      expectedRevision: foreign.revision,
      purpose: 'compose',
    })
  ).toThrow('OUTLINE_OUTSIDE_SCOPE');
  expect(() =>
    f.runtime.enqueue(conversation.id, 'stale', '변경', undefined, undefined, undefined, {
      nodeId: node.id,
      expectedRevision: node.revision,
      purpose: 'compose',
    })
  ).toThrow('다시 선택');
  expect(send).not.toHaveBeenCalled();
  const task = f.runtime.enqueue(
    conversation.id,
    'change',
    '이 유지 조건 자체를 새 결말로 바꿔줘',
    undefined,
    undefined,
    undefined,
    { nodeId: pinned.id, expectedRevision: pinned.revision, purpose: 'compose' }
  );
  await Promise.all(f.work);
  expect(f.workspace.task(task.id).status).toBe('completed');
  expect(f.store.outline.node(pinned.id)).toMatchObject({
    fixed: true,
    intent: '명시 요청으로 변경한 결말',
  });
  expect(f.store.outline.node(foreign.id).intent).toBe('');
  expect(f.store.chat(chat.id).headRevision).toBeNull();
});
