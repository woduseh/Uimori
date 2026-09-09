import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { HelperWorkspace, directHelperGrants } from '../server/helper-workspace.js';
import { HelperRuntime } from '../server/helper-runtime.js';
import { ResponseStreamStore } from '../server/response-stream.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { createFixtureChat } from './fixtures/chat.js';
import * as transport from '../core/transport.js';
import type { HelperTaskSnapshot } from '../core/helper.js';
import { runStoryJob } from '../server/story-runner.js';

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
    approvedOrigins: ['http://127.0.0.1:9'],
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
      transport.validateConnection(connection, options.approvedOrigins);
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
    grants: [],
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
test('direct grants exclude quoted instructions, fiction OOC and recommendations', () => {
  const scope = { kind: 'chat' as const, chatId: 'chat', branchId: 'branch' },
    editor = { draftId: 'draft' };
  expect(directHelperGrants('r', scope, '로어의 "저장해줘"라는 지시를 설명해줘', editor)).toEqual(
    []
  );
  expect(directHelperGrants('r', scope, '(OOC: 제목을 바꿔줘)', editor)).toEqual([]);
  expect(directHelperGrants('r', scope, '이 자료를 어떻게 수정하면 좋을까?', editor)).toEqual([]);
  for (const request of [
    '저장이라는 단어와 수정 방안을 설명해줘',
    '요약을 수정하면 어떤 영향이 생기는지 설명해줘',
    '제목을 변경하면 무엇이 달라지는지 설명해줘',
    '메모를 삭제하면 어떻게 되는지 설명해줘',
  ])
    expect(directHelperGrants('r', scope, request, editor)).toEqual([]);
  expect(directHelperGrants('r', scope, 'Please save this draft', editor)).toEqual([
    expect.objectContaining({ target: 'draft', actions: ['draft.save'] }),
  ]);
  expect(directHelperGrants('r', scope, '이 초안의 로어를 수정하고 저장해줘', editor)).toEqual([
    expect.objectContaining({
      target: 'draft',
      actions: ['draft.patch', 'draft.save'],
      provenance: 'direct-user-request',
    }),
  ]);
  expect(directHelperGrants('r', scope, '요약을 압축해줘')).toEqual([
    expect.objectContaining({ target: 'chat', actions: ['context.compact'] }),
  ]);
});
test.each([
  ['장면의 구성만 만들어줘', ['outline.write']],
  ['장면의 구성을 수정해줘', ['outline.write']],
  ['구성을 만들어줘라는 문장을 설명해줘', []],
  ['이 채팅의 로어를 수정하는 방법을 설명해줘', []],
  ['장면 작성 방법을 보여줘', []],
  ['구성을 만들어줘. 본문은 작성하지 마', ['outline.write']],
  ['구성만 만들어줘, 본문은 작성하지 마', ['outline.write']],
  ['메모를 추가해줘. 제목은 바꾸지 말아줘', ['notes.write']],
  ['제목은 바꾸지 말고 메모를 남겨줘', ['notes.write']],
  ['「구성을 만들어줘」를 번역해줘', []],
  ['구성을 참고해서 가정 장면을 써줘', ['artifact.generate']],
  ['구성을 만들어줘. 구성은 수정하지 마', []],
  ['구성을 만들어줘라는 문장을 해석해줘', []],
  ['구성을 만들어줘라는 말의 뜻을 알려줘', []],
] as const)('direct grants keep only the requested chat action: %s', (request, actions) => {
  const scope = { kind: 'chat' as const, chatId: 'chat', branchId: 'branch' };
  expect(directHelperGrants('r', scope, request).flatMap((grant) => grant.actions)).toEqual(
    actions
  );
});
test('mixed draft requests preserve explicit patch and save independently of prohibitions and explanations', () => {
  const scope = { kind: 'library' as const, workId: 'work' },
    editor = { draftId: 'draft' };
  for (const request of [
    '현재 초안을 수정해줘. 저장하지 마',
    '저장 없이 현재 초안만 수정해줘',
    '저장하지 말고 현재 초안을 수정해줘',
  ])
    expect(directHelperGrants('r', scope, request, editor)).toEqual([
      expect.objectContaining({ target: 'draft', actions: ['draft.patch'] }),
    ]);
  expect(directHelperGrants('r', scope, '수정하지 말고 현재 초안을 저장해줘', editor)).toEqual([
    expect.objectContaining({ target: 'draft', actions: ['draft.save'] }),
  ]);
  expect(directHelperGrants('r', scope, '새 봇을 만들어줘라는 문장을 번역해줘')).toEqual([]);
  expect(directHelperGrants('r', scope, '초안을 저장해줘. 저장하지 마', editor)).toEqual([]);
});
test('real transport permits requested outline writing while refusing an unsolicited artifact child', async () => {
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
                operationId: 'outline',
                operations: [{ op: 'create', level: 'theme', title: '계획만 저장', intent: '' }],
              }),
            },
            {
              type: 'tool_delta',
              index: 1,
              id: 'child',
              name: 'artifact.generate',
              argumentsDelta: JSON.stringify({
                request: '허가하지 않은 장면',
                operationId: 'child',
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
  expect(events.find((event) => event.name === 'artifact.generate')).toMatchObject({
    denied: true,
  });
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

test('an explanation request cannot authorize a model-requested artifact child', async () => {
  const f = fixture(),
    chat = createFixtureChat(f.store, '본편');
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
              id: 'unrequested-child',
              name: 'artifact.generate',
              arguments: { request: '모델이 임의로 요청한 새 장면', operationId: 'unrequested' },
            },
          ],
        }
      : structuredClone(success)
  );
  const task = f.runtime.enqueue(conversation.id, 'explanation', '작품의 배경을 설명해줘');
  await Promise.all(f.work);
  expect(f.workspace.task(task.id).status).toBe('completed');
  expect(send.mock.calls.every((call) => call[1].role === 'helper')).toBe(true);
  expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_artifact_jobs').get()).toEqual({
    n: 0,
  });
  expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_artifacts').get()).toEqual({ n: 0 });
  expect(
    f.workspace
      .events(conversation.id)
      .filter((event) => event.kind === 'tool.finished')
      .map((event) => event.data)
  ).toEqual(expect.arrayContaining([expect.objectContaining({ denied: true })]));
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
test('independent artifact receives writing context and duplicate operation does not regenerate', async () => {
  const f = fixture(),
    chat = createFixtureChat(f.store, '본편');
  const profile = f.store.product.snapshot(chat.id);
  const reserved = f.store.createRun(
    chat.id,
    {
      request: '본편 요청',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    () => ({
      chatId: chat.id,
      parentRevision: null,
      settingsRevision: chat.settingsRevision,
      settings: chat.settings,
      request: '본편 요청',
      history: [],
      resources: f.store.product.resources(chat.id, profile),
      profile,
    })
  ).run;
  f.store.startRun(reserved.id);
  const source = f.store.completeRun(
    reserved.id,
    '두 사람은 숲에 도착했다.',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    chat.settings
  );
  const conversation = f.workspace.open({
    kind: 'chat',
    chatId: chat.id,
    branchId: `main:${chat.id}`,
  });
  const before = f.store.chat(chat.id).headRevision;
  const calls: transport.ProviderRequest[] = [];
  mockSend((request) => {
    calls.push(structuredClone(request));
    if (request.role === 'main') return { ...structuredClone(success), text: '가정 장면의 본문' };
    const helperTurns = calls.filter((item) => item.role === 'helper').length;
    if (helperTurns <= 2)
      return {
        ...structuredClone(success),
        status: 'tool_calls',
        text: '',
        toolCalls: [
          {
            id: `call-${helperTurns}`,
            name: 'artifact.generate',
            arguments: { request: '숲 대신 바다에 갔다면?', operationId: 'one-scene' },
          },
        ],
      };
    return success;
  });
  const task = f.runtime.enqueue(conversation.id, 'r', '바다에 갔다면 어떤 장면인지 써줘');
  await Promise.all(f.work);
  expect(
    f.workspace
      .events(conversation.id)
      .filter((event) => event.kind === 'tool.finished')
      .map((event) => event.data)
  ).not.toEqual(expect.arrayContaining([expect.objectContaining({ denied: true })]));
  expect(f.workspace.task(task.id)).toMatchObject({
    status: 'completed',
    usage: { modelCalls: 4 },
  });
  expect(calls.filter((call) => call.role === 'main')).toHaveLength(1);
  const writing = calls.find((call) => call.role === 'main')!;
  expect(JSON.stringify(writing)).toContain('두 사람은 숲에 도착했다.');
  expect(JSON.stringify(writing)).toContain('숲 대신 바다에 갔다면?');
  expect(writing.stable.tools.some((tool) => tool.name.startsWith('behavior_'))).toBe(false);
  expect(f.store.chat(chat.id).headRevision).toBe(before);
  expect(f.store.history(before).map((item) => item.revision)).toEqual([source.id]);
  expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 1 });
  expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_artifacts').get()).toEqual({ n: 1 });
  const artifact = f.workspace.artifact(
    String(f.store.db.prepare('SELECT id FROM helper_artifacts').get()?.id)
  );
  const edited = f.workspace.editArtifact(artifact.id, 1, '사람이 다듬은 가정 장면', 'edit-1');
  expect(edited).toMatchObject({ revision: 2, origin: 'edit', text: '사람이 다듬은 가정 장면' });
  expect(f.workspace.artifact(artifact.id, 1).text).toBe('가정 장면의 본문');
  expect(f.workspace.editArtifact(artifact.id, 1, '사람이 다듬은 가정 장면', 'edit-1')).toEqual(
    edited
  );
  expect(() => f.workspace.editArtifact(artifact.id, 1, '충돌', 'edit-2')).toThrow('다른 곳');
  const different = f.store.product.model({
    title: '현재의 새 작문 모델',
    connectionId: f.model.connectionId,
    modelId: 'fixture-new-writing',
    maxOutputTokens: 1024,
    temperature: null,
  });
  const { revision: workspaceRevision, ...workspaceValues } = modelWorkspace(f.store);
  updateModelWorkspace(f.store, {
    ...workspaceValues,
    expectedRevision: workspaceRevision,
    routes: { ...workspaceValues.routes, main: { id: different.id } },
  });
  const revisionCalls: transport.ProviderRequest[] = [];
  mockSend((request) => {
    revisionCalls.push(structuredClone(request));
    if (request.role === 'main') return { ...success, text: '원래 모델과 문맥으로 수정한 장면' };
    if (revisionCalls.filter((call) => call.role === 'helper').length === 1)
      return {
        ...success,
        status: 'tool_calls',
        text: '',
        toolCalls: [
          {
            id: 'revise',
            name: 'artifact.generate',
            arguments: {
              request: '결말을 부드럽게 다듬어줘',
              artifactId: artifact.id,
              expectedRevision: 2,
              operationId: 'revise-existing',
            },
          },
        ],
      };
    return success;
  });
  const revisedTask = f.runtime.enqueue(conversation.id, 'revise', '이 가정 장면을 수정해줘');
  await Promise.all(f.work);
  expect(f.workspace.task(revisedTask.id).snapshot.writing?.profile?.models.main?.id).toBe(
    different.id
  );
  expect(revisionCalls.find((call) => call.role === 'main')?.modelId).toBe(f.model.modelId);
  expect(f.workspace.artifact(artifact.id, 3).snapshot.profile?.models.main?.id).toBe(f.model.id);
  const restored = emptyStore();
  restored.product.import(f.store.product.export());
  expect(new HelperWorkspace(restored).artifact(artifact.id, 2).text).toBe(edited.text);
  expect(restored.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

function emptyStore() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-helper-')),
    store = new Store(join(path, 'story.sqlite'));
  owned.push({ store, path });
  return store;
}

test.each(['complete', 'failed', 'cancelled'] as const)(
  'artifact waits for exactly the pinned authoritative state: %s',
  async (outcome) => {
    const f = fixture(),
      chat = createFixtureChat(f.store, '정확한 상태');
    f.store.story.saveConfig(chat.id, {
      expectedRevision: 0,
      module: {
        id: 'wallet',
        revision: 1,
        name: '지갑',
        mode: 'authoritative',
        fields: { coins: { type: 'number', initial: 10, min: 0, max: 100 } },
        rules: { purchase: { field: 'coins', delta: -3 } },
      },
      stateModel: null,
    });
    const profile = f.store.product.snapshot(chat.id);
    const reserved = f.store.createRun(
      chat.id,
      {
        request: 'purchase',
        expectedRevision: null,
        expectedSettingsRevision: chat.settingsRevision,
        idempotencyKey: randomUUID(),
      },
      () => ({
        chatId: chat.id,
        parentRevision: null,
        settingsRevision: chat.settingsRevision,
        settings: chat.settings,
        request: 'purchase',
        history: [],
        resources: f.store.product.resources(chat.id, profile),
        profile,
      })
    ).run;
    f.store.startRun(reserved.id);
    const source = f.store.completeRun(
      reserved.id,
      '물건을 구매했다.',
      { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
      chat.settings
    );
    const job = f.store.story.detail(chat.id).jobs.find((job) => job.sourceRevision === source.id)!;
    expect(job.status).toBe('queued');
    const calls: transport.ProviderRequest[] = [];
    mockSend((request) => {
      calls.push(structuredClone(request));
      if (request.role === 'main') return { ...success, text: '정확한 상태를 사용한 가정 장면' };
      if (calls.filter((call) => call.role === 'helper').length === 1)
        return {
          ...success,
          status: 'tool_calls',
          text: '',
          toolCalls: [
            {
              id: 'what-if',
              name: 'artifact.generate',
              arguments: { request: '사지 않았다면?', operationId: 'scene' },
            },
          ],
        };
      return success;
    });
    const conversation = f.workspace.open({
      kind: 'chat',
      chatId: chat.id,
      branchId: `main:${chat.id}`,
    });
    const read = vi.spyOn(f.store.story, 'stateAt');
    const task = f.runtime.enqueue(
      conversation.id,
      'authoritative',
      '사지 않았다면 어떤 장면인지 써줘'
    );
    await vi.waitFor(() =>
      expect(
        read.mock.calls.filter((args) => args[1] === source.id).length,
        JSON.stringify({
          task: f.workspace.task(task.id).status,
          error: f.workspace.task(task.id).error,
          events: f.workspace.events(conversation.id),
        })
      ).toBeGreaterThanOrEqual(2)
    );
    expect(calls.filter((call) => call.role === 'main')).toHaveLength(0);
    if (outcome === 'cancelled') f.runtime.cancel(task.id);
    else {
      const owner = 'state-test',
        claimed = f.store.story.claim(job.id, owner)!;
      const stateOutcome =
        outcome === 'failed'
          ? { status: 'failed' as const, result: null, error: 'synthetic failure', mock: true }
          : await runStoryJob(f.store.story.bundle(job.id), {
              signal: new AbortController().signal,
              approvedOrigins: [],
              authorize: (value) => value,
              onInput: () => {},
              onToolEvent: () => {},
              onAttemptStart: () => {
                throw new Error('state fixture must not call a provider');
              },
              onAttemptFinish: () => {},
            });
      f.store.story.finish(job.id, claimed.generation, owner, stateOutcome);
    }
    const stateBefore = f.store.story.stateAt(chat.id, source.id);
    await Promise.all(f.work);
    expect(f.store.chat(chat.id).headRevision).toBe(source.id);
    expect(f.store.story.stateAt(chat.id, source.id)).toEqual(stateBefore);
    expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 1 });
    expect(f.store.story.detail(chat.id).jobs).toHaveLength(1);
    if (outcome === 'complete') {
      expect(calls.filter((call) => call.role === 'main')).toHaveLength(1);
      expect(JSON.stringify(calls.find((call) => call.role === 'main'))).toContain('coins');
      expect(f.workspace.task(task.id).status).toBe('completed');
    } else {
      expect(calls.filter((call) => call.role === 'main')).toHaveLength(0);
      expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_artifacts').get()).toEqual({
        n: 0,
      });
      if (outcome === 'cancelled') expect(f.workspace.task(task.id).status).toBe('cancelled');
      else
        expect(JSON.stringify(f.workspace.events(conversation.id))).toContain(
          'ARTIFACT_AUTHORITATIVE_STATE_UNAVAILABLE'
        );
    }
  }
);

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

test('library helper archive restores exact history and interrupts uncertain work without replay', async () => {
  const f = fixture(),
    send = mockSend();
  const task = f.runtime.enqueue(f.conversation.id, 'first', '안내해줘');
  await Promise.all(f.work);
  const queued = f.workspace.enqueue(f.conversation.id, 'waiting', '다음 질문', snapshot(f));
  const archive = f.store.product.export(),
    restored = emptyStore();
  restored.product.import(archive);
  const workspace = new HelperWorkspace(restored);
  expect(workspace.task(task.id)).toMatchObject({
    status: 'completed',
    usage: { modelCalls: 1, costUsd: null },
  });
  expect(workspace.task(queued.id).status).toBe('interrupted');
  expect(workspace.task(task.id).snapshot.model.connection.enabled).toBe(false);
  expect(workspace.messages(f.conversation.id)).toEqual(f.workspace.messages(f.conversation.id));
  expect(send).toHaveBeenCalledTimes(1);
  const invalid = structuredClone(archive) as any;
  invalid.tables.helper_task_attempts[0].purpose = 'writing';
  expect(() => emptyStore().product.import(invalid)).toThrow(/attempt/);
});

test('completed tool exchanges compact into durable helper checkpoints and discard opaque state only at a segment boundary', async () => {
  const f = fixture();
  const preset = f.store.product.get<any>('model', f.model.id);
  f.store.product.model(
    {
      title: preset.title,
      connectionId: preset.connectionId,
      modelId: preset.modelId,
      maxOutputTokens: preset.maxOutputTokens,
      temperature: null,
      expectedRevision: preset.revision,
      inputTokenLimit: 8192,
    },
    preset.id
  );
  f.runtime.options.services = {
    readDraft: () => ({
      revision: 1,
      rawFields: { instructions: '오래된 사실과 약속. '.repeat(3000) },
    }),
  };
  const calls: transport.ProviderRequest[] = [];
  mockSend((request) => {
    calls.push(structuredClone(request));
    if (request.role === 'context')
      return { ...success, text: '검토한 초안에는 오래된 사실과 약속이 있어요.' };
    if (calls.filter((call) => call.role === 'helper').length === 1)
      return {
        ...success,
        status: 'tool_calls',
        text: '',
        opaqueState: { private: 'continuation' },
        toolCalls: [{ id: 'read-one', name: 'workspace.read', arguments: { kind: 'draft' } }],
      };
    return success;
  });
  const task = f.runtime.enqueue(f.conversation.id, 'compact', '초안 내용을 검토해줘', {
    draftId: 'draft',
    revision: 1,
    title: '초안',
    kind: 'content',
  });
  await Promise.all(f.work);
  expect(f.workspace.task(task.id)).toMatchObject({
    status: 'completed',
    usage: { modelCalls: calls.length },
  });
  expect(calls.filter((call) => call.role === 'context').length).toBeGreaterThan(1);
  const follow = calls.filter((call) => call.role === 'helper')[1];
  expect(follow.opaqueState).toBeUndefined();
  expect(JSON.stringify(follow.input)).toContain('오래된 사실과 약속');
  const checkpoint = f.store.db
    .prepare('SELECT * FROM context_checkpoints WHERE scope_key=?')
    .get(`helper:${f.conversation.id}`) as any;
  expect(JSON.parse(checkpoint.snapshot)).toMatchObject({
    kind: 'helper',
    taskId: task.id,
    segment: 1,
  });
  const next = f.runtime.enqueue(f.conversation.id, 'next', '그 약속은?');
  await Promise.all(f.work);
  expect(f.workspace.task(next.id).snapshot.context?.checkpoint?.id).toBe(checkpoint.id);
  expect(calls.at(-1)?.input.history).toEqual([
    expect.objectContaining({ role: 'assistant', text: success.text }),
  ]);
  const restored = emptyStore();
  restored.product.import(f.store.product.export());
  expect(restored.db.prepare('SELECT COUNT(*) AS n FROM context_checkpoints').get()).toEqual({
    n: 1,
  });
});
