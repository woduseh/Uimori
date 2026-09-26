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
import { createFixtureChat } from './fixtures/chat.js';
import * as transport from '../core/transport.js';
import type { HelperTaskSnapshot } from '../core/helper.js';
import Fastify from 'fastify';
import { helperRoutes } from '../server/helper-routes.js';
import { HELPER_PERSONA_MAX_CHARS } from '../core/content-limits.js';
import { UI_HELPER_PERSONA } from '../web/helper-persona.js';

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
    branchId: `main:${chat.id}`,
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
    branchId: `main:${chat.id}`,
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
  expect(reopened.tasks(conversation.id)).toHaveLength(1);
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
  expect(reloaded.tasks(f.conversation.id)).toHaveLength(3);
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
    c = f.workspace.create(a.scope, 'c');
  const releases = new Map<string, () => void>();
  const calls: string[] = [];
  const histories = new Map<string, string[]>();
  let live = 0,
    peak = 0;
  mockSend(async (request) => {
    const name = String(request.input.task);
    calls.push(name);
    const activeTask = f.workspace
      .tasks(name.startsWith('A') ? a.id : name.startsWith('B') ? b.id : c.id)
      .find((task) => task.status === 'running')!;
    histories.set(
      name,
      activeTask.snapshot.history.map((message) => message.text)
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
