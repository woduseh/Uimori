import { createApp, type App } from '../server/app.js';
import { describe } from 'vitest';
import { afterEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { Store } from '../server/store.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { helperContext, helperHistory, publishHelperContext } from '../server/helper-context.js';
import { HelperRuntime } from '../server/helper-runtime.js';
import { ResponseStreamStore } from '../server/response-stream.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { editableResource } from '../core/resource-editing.js';
import { readResource, saveResource } from '../server/resource-service.js';
import * as transport from '../core/transport.js';
import type { ToolEvent } from '../core/types.js';
import type { Content } from '../core/product.js';
import {
  HELPER_TOOL_CALL_GRACE,
  HELPER_TOOL_CALL_LIMIT,
  type HelperTaskSnapshot,
} from '../core/helper.js';
import Fastify from 'fastify';
import { helperRoutes } from '../server/helper-routes.js';
import { HELPER_PERSONA_MAX_CHARS, REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { UI_HELPER_PERSONA } from '../web/helper-persona.js';
import { chatWithSource } from './fixtures/illustration.js';
import { readHelperTaskResults } from '../server/helper-task-results.js';
import { applyHelperResourceMutation } from '../server/helper-resource-mutation.js';
import { helperResourceOperation } from '../server/helper-resource-tools.js';
import {
  chatGenerationDefaults,
  saveChatGenerationDefaults,
} from '../server/chat-generation-defaults.js';

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
function fixture(inputTokenLimit?: number) {
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
    ...(inputTokenLimit === undefined ? {} : { inputTokenLimit }),
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

test('the request route validates the editor focus and the model receives it in source.editor', async () => {
  const f = fixture();
  const saved = f.store.product.content(fixtureBotInput('위치를 보낼 자료', '원래 본문'));
  let captured: transport.Json | undefined;
  mockSend((request) => {
    captured = request.input.source;
    return structuredClone(success);
  });
  const focus = {
    section: 'lore',
    item: { index: 1, label: '항구' },
    field: {
      section: 'lore',
      item: 1,
      field: 'content',
      label: '로어 본문',
      language: 'cbs',
      length: 14,
      usesCbs: true,
    },
    selection: { from: 2, to: 5, text: '에는 ' },
    diagnostic: {
      code: 'cbs.unclosed-call',
      severity: 'error',
      from: 6,
      to: 8,
      line: 1,
      column: 7,
    },
    unsavedSections: ['lore'],
  };
  const editor = {
    kind: 'content',
    source: 'saved',
    targetId: saved.id,
    revision: saved.revision,
    title: saved.title,
  };
  const app = Fastify();
  helperRoutes(app, f.runtime);
  try {
    const post = (requestKey: string, payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: `/api/helper/conversations/${f.conversation.id}/messages`,
        payload: { requestKey, text: '이 오류 고쳐 줘', editor: payload },
      });
    for (const [key, invalid] of [
      ['unknown-key', { ...focus, extra: true }],
      ['selection-without-field', { section: 'lore', selection: focus.selection }],
      ['selection-text-mismatch', { ...focus, selection: { from: 2, to: 5, text: '에' } }],
      ['bad-code', { ...focus, diagnostic: { ...focus.diagnostic, code: 'lua.syntax' } }],
      ['too-many', { ...focus, diagnostics: Array(11).fill(focus.diagnostic) }],
    ] as const) {
      const response = await post(key, { ...editor, focus: invalid });
      expect(response.statusCode, key).toBe(400);
      expect(response.json().message).toMatch(/^Invalid editor focus/u);
    }
    const accepted = await post('valid', { ...editor, focus });
    expect(accepted.statusCode, accepted.body).toBe(200);
    await Promise.all(f.work);
    expect(captured).toMatchObject({ editor: { hasUnsavedInput: false, focus } });
  } finally {
    await app.close();
  }
});

test('an unsaved editor is analysis input and a patch of that resource saves its saved revision', async () => {
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
  for (const resource of [saved, other])
    expect(readResource(f.store, 'content', resource.id)).toMatchObject({
      title: '변경된 제목',
      revision: resource.revision + 1,
    });
  expect(draft.title).toBe('편집 중인 자료');
  expect(f.workspace.task(task.id).status).toBe('completed');
  expect(
    f.store.db
      .prepare('SELECT COUNT(*) AS count FROM helper_operations WHERE task_id=?')
      .get(task.id)?.count
  ).toBe(2);
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

describe('a helper save under an unsaved editor draft overwrites neither side', () => {
  const descriptionPath = '/package/nativeRisu/card/description';
  const description = (store: Store, id: string) =>
    (readResource(store, 'content', id) as Content).package!.nativeRisu!.card.description;
  const editorOf = (resource: Content, model: ReturnType<typeof editableResource>) => ({
    kind: 'content' as const,
    source: 'unsaved' as const,
    targetId: resource.id,
    revision: resource.revision,
    title: resource.title,
    model,
  });
  const patchCall = (id: string, resource: Content, revision: number, value: string) => ({
    id,
    name: 'app.call',
    arguments: {
      name: 'resource.patch',
      arguments: {
        kind: 'content',
        id: resource.id,
        expectedRevision: revision,
        changes: [{ path: descriptionPath, op: 'set', value }],
      },
    },
  });
  const userSave = (store: Store, resource: Content, base: number, model: unknown) =>
    saveResource(store, {
      kind: 'content',
      id: resource.id,
      expectedRevision: base,
      model: model as never,
    });
  const withDescription = (model: ReturnType<typeof editableResource>, value: string) => {
    const next = structuredClone(model) as any;
    next.package.nativeRisu.card.description = value;
    return next as ReturnType<typeof editableResource>;
  };

  test('when the helper saves first, the user save of the older draft is refused as stale', async () => {
    const f = fixture();
    const resource = f.store.product.content(
      fixtureBotInput('초안 자료', '저장본 설명')
    ) as Content;
    const draft = withDescription(
      editableResource('content', readResource(f.store, 'content', resource.id)),
      '사용자의 미저장 설명'
    );
    const kept = structuredClone(draft);
    mockSend((request, _options, index) => {
      if (index === 0)
        return {
          ...structuredClone(success),
          status: 'tool_calls',
          toolCalls: [patchCall('helper-save', resource, resource.revision, '도우미 설명')],
        };
      expect(request.input.results).toMatchObject([{ denied: false }]);
      return structuredClone(success);
    });
    const task = f.runtime.enqueue(
      f.conversation.id,
      'helper-first',
      '설명을 고쳐줘',
      editorOf(resource, draft)
    );
    await Promise.all(f.work);
    expect(f.workspace.task(task.id)).toMatchObject({
      status: 'completed',
      snapshot: { seededOperations: ['editor.read', 'resource.read', 'resource.patch'] },
    });
    expect(description(f.store, resource.id)).toBe('도우미 설명');
    expect(() => userSave(f.store, resource, resource.revision, draft)).toThrow(
      expect.objectContaining({ statusCode: 409 })
    );
    expect(description(f.store, resource.id)).toBe('도우미 설명');
    expect(draft).toEqual(kept);
  });

  test('when the user saves first, the helper write guarded by the older revision is refused and succeeds after a re-read', async () => {
    const f = fixture();
    const resource = f.store.product.content(
      fixtureBotInput('초안 자료', '저장본 설명')
    ) as Content;
    const base = editableResource('content', readResource(f.store, 'content', resource.id));
    const draft = withDescription(base, '사용자가 저장할 설명');
    let userRevision = 0;
    mockSend((request, _options, index) => {
      if (index === 0) {
        userRevision = userSave(f.store, resource, resource.revision, draft).saved.revision;
        return {
          ...structuredClone(success),
          status: 'tool_calls',
          toolCalls: [patchCall('stale', resource, resource.revision, '도우미 설명')],
        };
      }
      if (index === 1) {
        expect(request.input.results).toMatchObject([
          { denied: true, result: { code: 'SOURCE_CONFLICT' } },
        ]);
        expect(description(f.store, resource.id)).toBe('사용자가 저장할 설명');
        return {
          ...structuredClone(success),
          status: 'tool_calls',
          toolCalls: [
            {
              id: 'reread',
              name: 'app.call',
              arguments: {
                name: 'resource.read',
                arguments: { kind: 'content', id: resource.id, path: descriptionPath },
              },
            },
          ],
        };
      }
      if (index === 2) {
        expect(request.input.results.at(-1)).toMatchObject({
          denied: false,
          result: { revision: userRevision },
        });
        return {
          ...structuredClone(success),
          status: 'tool_calls',
          toolCalls: [patchCall('fresh', resource, userRevision, '사용자가 저장할 설명 + 도우미')],
        };
      }
      expect(request.input.results.at(-1)).toMatchObject({ callId: 'fresh', denied: false });
      return structuredClone(success);
    });
    const task = f.runtime.enqueue(
      f.conversation.id,
      'user-first',
      '설명을 고쳐줘',
      editorOf(resource, draft)
    );
    await Promise.all(f.work);
    expect(f.workspace.task(task.id).status).toBe('completed');
    expect(readResource(f.store, 'content', resource.id).revision).toBe(userRevision + 1);
    expect(description(f.store, resource.id)).toBe('사용자가 저장할 설명 + 도우미');
  });
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
    limits: { totalCalls: 24, helperCalls: 12 },
  };
}

test('completed helper retains bounded call arguments, shell outcome and attempt timing', async () => {
  const f = fixture();
  const args = { command: `echo diagnostic\n#${'가'.repeat(1600)}\necho DIAGNOSTIC_END` };
  vi.spyOn(f.runtime.shell, 'exec').mockResolvedValue({
    exitCode: 7,
    signal: null,
    timedOut: false,
    outputBytes: 987654,
    truncated: true,
    output: 'PRIVATE_SHELL_OUTPUT',
    applied: [],
  });
  mockSend((_request, _options, index) =>
    index === 0
      ? {
          ...structuredClone(success),
          status: 'tool_calls',
          text: '',
          toolCalls: [
            { id: 'invalid', name: 'data.exec', arguments: { command: 123 } },
            { id: 'shell', name: 'data.exec', arguments: args },
          ],
        }
      : structuredClone(success)
  );
  const task = f.runtime.enqueue(f.conversation.id, 'diagnostic-retention', 'Inspect locally.');
  await Promise.all(f.work);
  expect(f.workspace.task(task.id).status).toBe('completed');
  const events = f.workspace.events(f.conversation.id);
  const data = (kind: string, callId: string) =>
    events.find(
      (event) =>
        event.kind === kind && (event.data as { callId?: string } | null)?.callId === callId
    )?.data as Record<string, any>;
  const started = data('tool.started', 'shell');
  expect(started).toMatchObject({
    name: 'data.exec',
    argsChars: JSON.stringify(args).length,
    argsSha256: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
    argsTruncated: true,
    argsRedacted: false,
    startedAt: expect.any(String),
  });
  expect(started.argsPreview.length).toBeLessThanOrEqual(1024);
  expect(started.argsPreview).toContain('echo diagnostic');
  expect(started.argsPreview).toContain('DIAGNOSTIC_END');
  expect(started.argsPreview).toContain('[arguments truncated]');
  expect(data('tool.finished', 'shell')).toMatchObject({
    denied: false,
    status: 'failed',
    finishedAt: expect.any(String),
    shell: { exitCode: 7, signal: null, timedOut: false, outputBytes: 987654, truncated: true },
    detailsOmitted: true,
  });
  expect(data('tool.finished', 'invalid')).toMatchObject({
    denied: true,
    errorCode: 'INVALID_SHELL_ARGUMENTS',
    detailsOmitted: true,
  });
  expect(JSON.stringify(events)).not.toContain('PRIVATE_SHELL_OUTPUT');
  const attempts = events.filter((event) => event.kind === 'attempt.finished');
  expect(attempts).toHaveLength(2);
  for (const event of attempts)
    expect(event.data).toMatchObject({
      finishedAt: expect.any(String),
      elapsedMs: expect.any(Number),
    });
});

test('app-wide helper history preserves original scopes, filters and deletion ownership', async () => {
  const f = fixture();
  const chat = createFixtureChat(f.store, '이전 작품');
  const chatConversation = f.workspace.create({ kind: 'chat', chatId: chat.id }, 'chat-history');
  const secondLibrary = f.workspace.create(
    { kind: 'library', workId: 'another' },
    'library-history'
  );
  const app = Fastify();
  helperRoutes(app, f.runtime);
  try {
    const response = await app.inject({ url: '/api/helper/conversations?kind=all' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: chatConversation.id,
          scope: chatConversation.scope,
          chatTitle: chat.title,
        }),
        expect.objectContaining({ id: f.conversation.id, scope: f.conversation.scope }),
        expect.objectContaining({ id: secondLibrary.id, scope: secondLibrary.scope }),
      ])
    );
    expect(response.json()).toHaveLength(3);
    expect(f.workspace.list({ kind: 'chat', chatId: chat.id }).map((item) => item.id)).toEqual([
      chatConversation.id,
    ]);
    expect(
      f.workspace
        .list({ kind: 'library' })
        .map((item) => item.id)
        .sort()
    ).toEqual([f.conversation.id, secondLibrary.id].sort());
    expect(f.workspace.conversation(chatConversation.id)).toEqual(chatConversation);
    f.workspace.delete(f.conversation.id, f.workspace.deletionImpact(f.conversation.id).request);
    expect(
      f.workspace
        .list({ kind: 'all' })
        .map((item) => item.id)
        .sort()
    ).toEqual([chatConversation.id, secondLibrary.id].sort());
    expect(f.store.chat(chat.id).title).toBe(chat.title);
    expect((await app.inject({ url: '/api/helper/conversations?kind=chat' })).statusCode).toBe(400);
  } finally {
    await app.close();
  }
});

test('helper results retain actual batch targets and safe settings outcomes after payload cleanup', async () => {
  const f = fixture(64_000);
  const changed = f.store.product.content(fixtureBotInput('수정 전', 'PRIVATE_RESOURCE_BODY'));
  const unchanged = f.store.product.content(fixtureBotInput('그대로'));
  const revision = modelWorkspace(f.store).revision;
  mockSend(
    (_request, _options, index): transport.ProviderResult =>
      index === 0
        ? {
            ...structuredClone(success),
            status: 'tool_calls',
            toolCalls: [
              {
                id: 'batch-change',
                name: 'app.call',
                arguments: {
                  name: 'resource.patchMany',
                  arguments: {
                    items: [
                      {
                        kind: 'content',
                        id: changed.id,
                        expectedRevision: changed.revision,
                        changes: [
                          { path: '/package/nativeRisu/card/name', op: 'set', value: '수정 후' },
                        ],
                      },
                      {
                        kind: 'content',
                        id: unchanged.id,
                        expectedRevision: unchanged.revision,
                        changes: [
                          {
                            path: '/package/nativeRisu/card/name',
                            op: 'set',
                            value: unchanged.title,
                          },
                        ],
                      },
                    ],
                  },
                },
              },
              {
                id: 'same-model',
                name: 'app.call',
                arguments: {
                  name: 'settings.update',
                  arguments: {
                    setting: 'global.mainModel',
                    expectedRevision: revision,
                    value: f.model.id,
                  },
                },
              },
            ],
          }
        : index === 1
          ? {
              ...structuredClone(success),
              status: 'tool_calls',
              toolCalls: [
                {
                  id: 'select-translation',
                  name: 'app.call',
                  arguments: {
                    name: 'settings.update',
                    arguments: {
                      setting: 'global.translationModel',
                      expectedRevision: modelWorkspace(f.store).revision,
                      value: f.model.id,
                    },
                  },
                },
              ],
            }
          : structuredClone(success)
  );
  const task = f.runtime.enqueue(
    f.conversation.id,
    'results-retained',
    '자료를 수정하고 번역 모델을 골라줘'
  );
  await Promise.all(f.work);
  expect(f.workspace.task(task.id).status).toBe('completed');
  f.store.product.model(
    {
      title: f.model.title,
      connectionId: f.model.connectionId,
      modelId: f.model.modelId,
      temperature: null,
      maxOutputTokens: 1024,
      inputTokenLimit: 128_000,
      expectedRevision: f.model.revision,
    },
    f.model.id
  );
  const app = Fastify();
  helperRoutes(app, f.runtime);
  try {
    const response = await app.inject({ url: `/api/helper/tasks/${task.id}/results` });
    expect(response.statusCode).toBe(200);
    const view = response.json();
    expect(view.results).toHaveLength(3);
    expect(
      view.results.find((item: { operation: string }) => item.operation === 'resource.patchMany')
    ).toMatchObject({
      requestedTargets: 2,
      changedTargets: 1,
      targets: [
        { kind: 'content', id: changed.id, title: '수정 후', revision: changed.revision + 1 },
      ],
    });
    expect(view.results).toContainEqual(
      expect.objectContaining({
        operation: 'settings.update',
        changedTargets: 0,
        requestedTargets: 1,
        targets: [],
      })
    );
    expect(view.results).toContainEqual(
      expect.objectContaining({
        targets: [
          expect.objectContaining({
            kind: 'settings',
            setting: 'global.translationModel',
            before: null,
            after: f.model.id,
            beforeLabel: null,
            afterLabel: f.model.title,
          }),
        ],
      })
    );
    expect(view.unrecordedOperations).toBe(0);
    expect(view.usage.toolExecutions).toBe(3);
    expect(view.usage.attempts).toHaveLength(3);
    expect(view.usage.latestInputEstimate).toBeGreaterThan(0);
    expect(view.usage.latestInputLimit).toBe(64_000);
    expect(view.usage.latestInputExecution).toBe('provider-tool-loop');
    expect(view.usage.latestInputParts).toEqual({
      instructions: expect.any(Number),
      toolSchemas: expect.any(Number),
      history: expect.any(Number),
      source: expect.any(Number),
      toolResults: expect.any(Number),
    });
    expect(response.body).not.toContain('PRIVATE_RESOURCE_BODY');
    expect(response.body).not.toContain('127.0.0.1');
    expect(
      f.store.db
        .prepare('SELECT result FROM helper_operations WHERE task_id=?')
        .all(task.id)
        .every((row) => JSON.parse(String(row.result)).detailsOmitted)
    ).toBe(true);
    expect((await app.inject({ url: '/api/helper/tasks/missing/results' })).statusCode).toBe(404);
  } finally {
    await app.close();
  }
});

test('task result usage preserves reported native token detail, unknown internal calls and unrecorded operations', () => {
  const f = fixture();
  const task = f.workspace.enqueue(f.conversation.id, 'usage-result', '사용량 확인', snapshot(f));
  f.workspace.start(task.id, 'usage-owner');
  const attempt = f.workspace.startAttempt(task.id, 'usage-owner', 1, 'helper', 0, {
    connectionId: f.model.connectionId,
    protocol: 'codex-app-server-v1',
    role: 'helper',
    modelId: f.model.modelId,
    method: 'POST',
    url: 'https://private-endpoint.invalid/secret',
    headers: { authorization: 'PRIVATE_CREDENTIAL' },
    body: { private: 'PRIVATE_REQUEST_BODY' },
    bodySha256: 'synthetic',
    stablePrefixSha256: 'synthetic',
  });
  f.workspace.finishAttempt(task.id, attempt, {
    ...structuredClone(success),
    usage: {
      ...success.usage,
      raw: {
        kind: 'codex-agent-turn',
        modelCalls: null,
        tokenUsage: {
          total: {
            inputTokens: 10,
            cachedInputTokens: 6,
            outputTokens: 4,
            reasoningOutputTokens: 2,
          },
        },
        private: 'PRIVATE_RAW_USAGE',
      },
    },
  });
  f.workspace.operation(task.id, 'old-receipt', {}, () => ({ old: 'PRIVATE_RESULT' }));
  f.workspace.event(f.conversation.id, task.id, 'tool.finished', { name: 'unreported-tool' });
  f.workspace.event(f.conversation.id, task.id, 'input.measured', {
    estimatedInputTokens: 321,
    inputTokenLimit: 64_000,
  });
  f.workspace.finish(task.id, 'usage-owner', 1, 'completed', '완료', null);
  const view = readHelperTaskResults(f.store, task.id);
  expect(view.results).toEqual([]);
  expect(view.unrecordedOperations).toBe(1);
  expect(view.usage).toEqual({
    attempts: [
      {
        id: attempt,
        kind: 'helper',
        owner: 'helper',
        sceneRunId: null,
        purpose: 'helper',
        modelId: f.model.modelId,
        status: 'completed',
        startedAt: expect.any(String),
        elapsedMs: expect.any(Number),
        firstByteMs: null,
        inputTokens: 10,
        outputTokens: 4,
        costUsd: null,
        estimatedUsd: null,
        estimatedSubtotalUsd: 0,
        cachedInputTokens: 6,
        reasoningTokens: 2,
        internalModelCalls: null,
        tools: [{ name: 'unreported-tool', resultChars: null, elapsedMs: null, failed: false }],
      },
    ],
    toolExecutions: 1,
    latestInputTokens: null,
    latestInputEstimate: 321,
    latestInputLimit: 64_000,
    latestInputParts: null,
    latestInputExecution: null,
  });
  expect(JSON.stringify(view)).not.toContain('PRIVATE_');
  expect(JSON.stringify(view)).not.toContain('private-endpoint');
});

test.each([
  ['codex-app-server-v1', { tokenUsage: { last: { inputTokens: 90_040 } } }, 90_040],
  ['codex-app-server-v1', { tokenUsage: { total: { inputTokens: 647_519 } } }, null],
  ['fixture-sse-v1', null, 647_519],
] as const)(
  'latest input uses a helper request, never native cumulative usage: %s',
  (protocol, raw, expected) => {
    const f = fixture();
    const task = f.workspace.enqueue(f.conversation.id, 'latest-input', '사용량 확인', snapshot(f));
    f.workspace.start(task.id, 'owner');
    const wire: transport.WireRecord = {
      connectionId: f.model.connectionId,
      protocol,
      role: 'helper',
      modelId: f.model.modelId,
      method: 'POST',
      url: 'https://example.invalid/',
      headers: {},
      body: {},
      bodySha256: 'synthetic',
      stablePrefixSha256: 'synthetic',
    };
    const helper = f.workspace.startAttempt(task.id, 'owner', 1, 'helper', 0, wire);
    f.workspace.finishAttempt(task.id, helper, {
      ...structuredClone(success),
      usage: { ...success.usage, inputTokens: 647_519, raw: raw as transport.Json },
    });
    const context = f.workspace.startAttempt(task.id, 'owner', 1, 'context', 0, wire);
    f.workspace.finishAttempt(task.id, context, {
      ...structuredClone(success),
      usage: { ...success.usage, inputTokens: 999_999 },
    });
    expect(readHelperTaskResults(f.store, task.id).usage.latestInputTokens).toBe(expected);
    const unknown = f.workspace.startAttempt(task.id, 'owner', 1, 'helper', 1, wire);
    f.workspace.finishAttempt(task.id, unknown, {
      ...structuredClone(success),
      usage: { ...success.usage, inputTokens: null, raw: null },
    });
    f.workspace.finish(task.id, 'owner', 1, 'completed', '완료', null);
    const usage = readHelperTaskResults(f.store, task.id).usage;
    expect(usage.latestInputTokens).toBeNull();
    expect(usage.attempts[0].inputTokens).toBe(647_519);
  }
);

test('resource creation, undo, clone and deletion outcomes retain identities without extending undo or surviving rollback', () => {
  const f = fixture();
  const task = f.workspace.enqueue(
    f.conversation.id,
    'resource-lifecycle',
    '자료 관리',
    snapshot(f)
  );
  f.workspace.start(task.id, 'resource-owner');
  let next = 0;
  const apply = (name: string, args: Record<string, unknown>) => {
    const operation = helperResourceOperation(name, args);
    if (!operation || operation.readOnly) throw new Error('Expected resource mutation');
    const receiptId = `lifecycle-${next++}`;
    return f.workspace.operation(task.id, receiptId, { name, args }, () =>
      applyHelperResourceMutation(
        f.store,
        f.workspace,
        task,
        receiptId,
        name,
        args,
        operation.targets ?? operation.target
      )
    ) as { id: string; revision: number };
  };
  const created = apply('resource.save', { kind: 'content', model: fixtureBotInput('새 자료') });
  const changed = apply('resource.patch', {
    kind: 'content',
    id: created.id,
    expectedRevision: created.revision,
    changes: [{ path: '/package/nativeRisu/card/name', op: 'set', value: '고친 자료' }],
  });
  const restored = apply('resource.undo', {
    kind: 'content',
    id: created.id,
    expectedRevision: changed.revision,
  });
  const cloned = apply('resource.clone', {
    kind: 'content',
    sourceId: created.id,
    expectedSourceRevision: restored.revision,
    title: '복제 자료',
  });
  apply('resource.delete', { kind: 'content', id: cloned.id, expectedRevision: cloned.revision });
  const results = readHelperTaskResults(f.store, task.id).results;
  expect(results.map((item) => [item.operation, item.changedTargets, item.targets[0]?.id])).toEqual(
    [
      ['resource.save', 1, created.id],
      ['resource.patch', 1, created.id],
      ['resource.undo', 1, created.id],
      ['resource.clone', 1, cloned.id],
      ['resource.delete', 1, cloned.id],
    ]
  );
  expect(results.at(-1)?.targets).toEqual([
    { kind: 'content', id: cloned.id, revision: cloned.revision, title: '복제 자료' },
  ]);
  expect(() =>
    f.workspace.operation(task.id, 'rolled-back', {}, () => {
      applyHelperResourceMutation(
        f.store,
        f.workspace,
        task,
        'rolled-back',
        'resource.patch',
        {
          kind: 'content',
          id: created.id,
          expectedRevision: restored.revision,
          changes: [
            { path: '/package/nativeRisu/card/name', op: 'set', value: '저장되면 안 돼요' },
          ],
        },
        { kind: 'content', id: created.id }
      );
      throw new Error('forced rollback');
    })
  ).toThrow('forced rollback');
  expect(readResource(f.store, 'content', created.id).revision).toBe(restored.revision);
  expect(readHelperTaskResults(f.store, task.id).results).toEqual(results);
});

test('helper requests expose only remaining host calls at each boundary', async () => {
  const f = fixture();
  const requests: transport.ProviderRequest[] = [];
  mockSend((request, _options, index) => {
    requests.push(structuredClone(request));
    return index === 0
      ? {
          ...structuredClone(success),
          status: 'tool_calls',
          text: '',
          toolCalls: [{ id: 'discover', name: 'app.tools', arguments: {} }],
        }
      : structuredClone(success);
  });
  const task = f.runtime.enqueue(f.conversation.id, 'budget-guidance', '가능한 작업을 알려줘');
  await Promise.all(f.work);
  expect(f.workspace.task(task.id)).toMatchObject({
    status: 'completed',
    usage: { modelCalls: 2 },
  });
  expect(requests.map((request) => request.input.controls)).toEqual([
    expect.objectContaining({
      helperCallsRemaining: 64,
      totalCallsRemaining: 128,
      includesCurrentCall: true,
      nativeInternalCalls: null,
    }),
    expect.objectContaining({
      helperCallsRemaining: 63,
      totalCallsRemaining: 127,
      includesCurrentCall: true,
      nativeInternalCalls: null,
    }),
  ]);
  expect(requests[0].webSearch).toBeUndefined();
  expect(requests[0].input.source).toMatchObject({
    webSearch: { supported: false, mode: 'unavailable' },
    currentDateUtc: new Date().toISOString().slice(0, 10),
  });
});

test.each(['provider', 'native'] as const)(
  'helper %s execution answers calls past 256 host tool callbacks without running them, then stops',
  async (execution) => {
    const f = fixture();
    f.store.db.exec('PRAGMA synchronous=NORMAL');
    const calls = Array.from({ length: HELPER_TOOL_CALL_LIMIT }, (_, index) => ({
      id: `callback-${index}`,
      name: 'missing.tool',
      arguments: {},
    }));
    let runtime = f.runtime;
    let nativeSignal: AbortSignal | undefined;
    if (execution === 'native') {
      const connection = f.store.product.connection({
        title: 'Native callback guard',
        protocol: 'codex-app-server-v1',
        endpoint: 'codex://local',
        enabled: true,
      });
      const model = f.store.product.model({
        title: 'Native callback guard',
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
      runtime = new HelperRuntime(f.store, {
        owner: 'native-callback-guard',
        signal: f.controller.signal,
        track: (work) => f.work.push(work),
        streams: f.streams,
        executeCodexAgent: async (_connection, _request, options) => {
          nativeSignal = options.signal;
          for (const call of calls) {
            await options.onToolCall(
              { name: call.name, arguments: call.arguments, callId: call.id },
              options.signal
            );
          }
          for (let index = 0; index < HELPER_TOOL_CALL_GRACE; index++) {
            const denied = await options.onToolCall(
              { name: 'missing.tool', arguments: {}, callId: `over-budget-${index}` },
              options.signal
            );
            expect(denied.success).toBe(false);
            expect(denied.text).toContain('HELPER_TOOL_CALL_BUDGET_EXHAUSTED');
          }
          await expect(
            options.onToolCall(
              { name: 'missing.tool', arguments: {}, callId: 'past-grace' },
              options.signal
            )
          ).rejects.toThrow('HELPER_TOOL_CALL_BUDGET_EXHAUSTED');
          return structuredClone(success);
        },
      });
    } else {
      mockSend((request, _options, index) => {
        expect(request.input.controls).toMatchObject(index === 0 ? {} : { finalCall: true });
        return {
          ...structuredClone(success),
          status: 'tool_calls',
          text: '',
          toolCalls:
            index === 0
              ? [...calls, { id: 'over-budget', name: 'missing.tool', arguments: {} }]
              : [{ id: 'after-final', name: 'missing.tool', arguments: {} }],
        };
      });
    }
    const task = runtime.enqueue(f.conversation.id, 'callback-guard', '도구를 확인해줘');
    await Promise.all(f.work);
    expect(f.workspace.task(task.id)).toMatchObject({
      status: 'failed',
      error: 'HELPER_TOOL_CALL_BUDGET_EXHAUSTED',
    });
    const firstPage = f.workspace.events(f.conversation.id);
    const remaining = f.workspace.events(f.conversation.id, firstPage.at(-1)!.seq);
    expect(
      [...firstPage, ...remaining].filter((event) => event.kind === 'tool.finished')
    ).toHaveLength(HELPER_TOOL_CALL_LIMIT + (execution === 'native' ? HELPER_TOOL_CALL_GRACE : 1));
    if (execution === 'native') expect(nativeSignal?.aborted).toBe(true);
  }
);

test('the last call the budget allows reports the work instead of failing', async () => {
  const f = fixture();
  const task = f.runtime.enqueue(
    f.conversation.id,
    'final-call',
    '도구를 확인해줘',
    undefined,
    undefined,
    undefined,
    undefined,
    false
  );
  task.snapshot.limits = { helperCalls: 2, totalCalls: 2 };
  f.store.db
    .prepare('UPDATE helper_tasks SET snapshot=? WHERE id=?')
    .run(JSON.stringify(task.snapshot), task.id);
  const controls: unknown[] = [];
  mockSend((request, _options, index) => {
    controls.push(request.input.controls);
    return index === 0
      ? {
          ...structuredClone(success),
          status: 'tool_calls',
          text: '',
          toolCalls: [{ id: 'first-read', name: 'missing.tool', arguments: {} }],
        }
      : { ...structuredClone(success), text: '여기까지 했고, 남은 일은 이거예요.' };
  });
  f.runtime.pump();
  await Promise.all(f.work);
  expect(controls[0]).not.toHaveProperty('finalCall');
  expect(controls[1]).toMatchObject({ finalCall: true, helperCallsRemaining: 1 });
  expect(f.workspace.task(task.id)).toMatchObject({
    status: 'completed',
    usage: { modelCalls: 2 },
  });
});

test('HTTP steering skips a stale write, delivers once and retains the correction in future history', async () => {
  const f = fixture();
  const chat = createFixtureChat(f.store, '원래 제목');
  const conversation = f.workspace.open({ kind: 'chat', chatId: chat.id });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: transport.ProviderRequest[] = [];
  mockSend(async (request, _options, index) => {
    requests.push(structuredClone(request));
    if (index === 0) {
      entered();
      await gate;
      return {
        ...structuredClone(success),
        status: 'tool_calls',
        text: '',
        toolCalls: [
          {
            id: 'stale-rename',
            name: 'app.call',
            arguments: {
              name: 'chat.rename',
              arguments: {
                title: '바꾸면 안 되는 제목',
                expectedRevision: chat.titleRevision ?? 0,
              },
            },
          },
        ],
      };
    }
    return { ...structuredClone(success), text: '제목은 유지하고 설명했어요.' };
  });
  const task = f.runtime.enqueue(conversation.id, 'steer-http', '제목을 바꿔줘');
  await started;
  const correction = '잠깐, 제목은 그대로 두고 설명만 해줘.';
  const accepted = f.runtime.steer(task.id, 'correction', correction);
  expect(accepted.status).toBe('pending');
  expect(f.runtime.steer(task.id, 'correction', correction).id).toBe(accepted.id);
  release();
  await Promise.all(f.work);
  expect(f.workspace.task(task.id).status).toBe('completed');
  expect(f.store.chat(chat.id).title).toBe('원래 제목');
  expect(requests).toHaveLength(2);
  expect(requests[1].input.task).toContain(correction);
  expect(requests[1].input.results).toEqual([
    expect.objectContaining({
      callId: 'stale-rename',
      denied: true,
      errorKind: 'recoverable',
      result: expect.objectContaining({ error: 'USER_INSTRUCTION_UPDATED' }),
    }),
  ]);
  expect(f.workspace.instructions(task.id)).toEqual([
    expect.objectContaining({ id: accepted.id, text: correction, status: 'delivered' }),
  ]);
  expect(f.runtime.steer(task.id, 'correction', correction)).toMatchObject({
    id: accepted.id,
    status: 'delivered',
  });
  expect(() => f.runtime.steer(task.id, 'correction', '다른 내용')).toThrow('같은 요청 키');
  expect(() => f.runtime.steer(task.id, 'too-late', '끝난 뒤의 지시')).toThrow(
    'HELPER_TASK_NO_LONGER_ACTIVE'
  );
  const next = f.runtime.enqueue(conversation.id, 'follow-up', '이제 이어서 설명해줘');
  await Promise.all(f.work);
  expect(f.workspace.task(next.id).status).toBe('completed');
  const previous = (requests[2].input.history as HelperTaskSnapshot['history']).filter(
    (message) => message.role === 'user'
  );
  expect(previous).toHaveLength(1);
  expect(previous[0].text.split(correction)).toHaveLength(2);
});

test.each(['delivered', 'unconfirmed'] as const)(
  'native steering keeps a %s receipt without replaying the instruction',
  async (status) => {
    const f = fixture();
    const connection = f.store.product.connection({
      title: 'Native steering',
      protocol: 'codex-app-server-v1',
      endpoint: 'codex://local',
      enabled: true,
    });
    const model = f.store.product.model({
      title: 'Native steering',
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
    let ready!: () => void;
    const registered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => {
      if (status === 'unconfirmed') throw new Error('Native process closed before acknowledgement');
    });
    const runtime = new HelperRuntime(f.store, {
      owner: 'native-steering-test',
      signal: f.controller.signal,
      track: (work) => f.work.push(work),
      streams: f.streams,
      executeCodexAgent: async (_connection, _request, options) => {
        const detach = options.onSteerReady?.(send);
        ready();
        await gate;
        detach?.();
        return structuredClone(success);
      },
    });
    const task = runtime.enqueue(f.conversation.id, 'native-steer', '자료를 확인해줘');
    await registered;
    const correction = '지금은 설명문만 확인해줘.';
    const accepted = runtime.steer(task.id, 'native-correction', correction);
    await vi.waitFor(() => expect(runtime.workspace.instructions(task.id)[0].status).toBe(status));
    expect(runtime.steer(task.id, 'native-correction', correction).id).toBe(accepted.id);
    release();
    await Promise.all(f.work);
    expect(runtime.workspace.task(task.id).status).toBe('completed');
    expect(send).toHaveBeenCalledExactlyOnceWith(correction);
    expect(runtime.workspace.instructions(task.id)).toEqual([
      expect.objectContaining({ id: accepted.id, status }),
    ]);
    const message = helperHistory(f.store, f.conversation.id).find((item) => item.role === 'user')!;
    expect(message.text.includes(correction)).toBe(status === 'delivered');
  }
);

test('live helper counters preserve attempt budgets and completion without loading the manuscript', () => {
  const f = fixture();
  const task = f.workspace.enqueue(f.conversation.id, 'live-state', '사용량 확인', {
    ...snapshot(f),
    history: [{ id: 'large-history', role: 'user', text: 'Reserved prose. '.repeat(350_000) }],
    limits: { totalCalls: 1, helperCalls: 1 },
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
    expect(queries.mock.calls.length).toBeLessThanOrEqual(4);
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

test.each([null, false, 0, ''] as const)(
  'falsy operation result %s is replayed until completed task details are released',
  (value) => {
    const f = fixture();
    const task = f.workspace.enqueue(f.conversation.id, 'receipt', 'save', snapshot(f));
    f.workspace.start(task.id, 'owner');
    const input = { name: 'save' };
    expect(f.workspace.operation(task.id, 'receipt-op', input, () => value)).toBe(value);
    expect(f.workspace.operationResult(task.id, 'receipt-op', input)).toBe(value);
    expect(
      f.workspace.operation(task.id, 'receipt-op', input, () => {
        throw new Error('must not repeat');
      })
    ).toBe(value);
    expect(() => f.workspace.operationResult(task.id, 'receipt-op', { name: 'other' })).toThrow(
      'OPERATION_ID_CONFLICT'
    );
    expect(f.workspace.finish(task.id, 'owner', 1, 'completed', '', null)).toBe(true);
    expect(() => f.workspace.operationResult(task.id, 'receipt-op', input)).toThrow(
      'HELPER_TASK_NO_LONGER_ACTIVE'
    );
    expect(() => f.workspace.operation(task.id, 'receipt-op', input, () => value)).toThrow(
      'HELPER_TASK_NO_LONGER_ACTIVE'
    );
  }
);

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

test('a helper shell call previews 64 KB of output unless the model asks for less', async () => {
  vi.stubEnv('UIMORI_SHELL_ROOT', join(tmpdir(), 'uimori-no-shell-root'));
  const f = fixture();
  const exec = vi
    .spyOn(f.runtime.shell, 'exec')
    .mockResolvedValue({ exitCode: 0, output: 'ok', truncated: false });
  const requests: transport.ProviderRequest[] = [];
  mockSend((request, _options, index) => {
    requests.push(structuredClone(request));
    return index === 0
      ? {
          ...structuredClone(success),
          status: 'tool_calls',
          text: '',
          toolCalls: [
            { id: 'default', name: 'data.exec', arguments: { command: 'true' } },
            {
              id: 'small',
              name: 'data.exec',
              arguments: { command: 'true', maxOutputBytes: 1024 },
            },
          ],
        }
      : structuredClone(success);
  });
  const task = f.runtime.enqueue(f.conversation.id, 'shell', '자료를 확인해줘');
  await Promise.all(f.work);
  vi.unstubAllEnvs();
  expect(f.workspace.task(task.id)).toMatchObject({ status: 'completed' });
  expect(exec.mock.calls.map((call) => call[6])).toEqual([65_536, 1024]);
  const shell = requests[0].stable.tools.find((tool) => tool.name === 'data.exec')!;
  expect(
    (shell.inputSchema as { properties: { maxOutputBytes: { description: string } } }).properties
      .maxOutputBytes.description
  ).toContain('Default 65536');
});

function stoppedAfterRename(f: ReturnType<typeof fixture>) {
  const chat = createFixtureChat(f.store, '원 제목');
  const conversation = f.workspace.open({ kind: 'chat', chatId: chat.id });
  const requests: transport.ProviderRequest[] = [];
  const replies: transport.ProviderResult[] = [
    {
      ...structuredClone(success),
      status: 'tool_calls',
      text: '',
      toolCalls: [
        { id: 'catalog', name: 'app.tools', arguments: { query: 'chat' } },
        {
          id: 'rename',
          name: 'chat.rename',
          arguments: { title: '저장 완료', expectedRevision: chat.titleRevision ?? 0 },
        },
      ],
    },
    { ...structuredClone(success), status: 'error', text: '', error: { code: 'UNEXPECTED_EOF' } },
  ];
  mockSend((request) => {
    requests.push(structuredClone(request));
    return replies.shift() ?? structuredClone(success);
  });
  const resume = (key: string, previous: string) =>
    f.runtime.enqueue(
      conversation.id,
      key,
      '제목을 바꿔줘',
      undefined,
      undefined,
      previous,
      undefined,
      true,
      undefined,
      { resume: true }
    );
  const source = (request: transport.ProviderRequest) =>
    request.input.source as unknown as {
      continuation?: { reason: string };
      completedToolHistory?: { events: ToolEvent[] };
    };
  return { chat, conversation, requests, replies, resume, source };
}

test('resuming a stopped task hands its recorded exchanges to the model and repeats no saved change', async () => {
  const f = fixture(),
    { chat, conversation, requests, resume, source } = stoppedAfterRename(f);
  const stopped = f.runtime.enqueue(conversation.id, 'first', '제목을 바꿔줘');
  await Promise.all(f.work);
  expect(f.workspace.task(stopped.id)).toMatchObject({
    status: 'failed',
    resumable: true,
    completedEffects: { count: 1 },
  });
  expect(f.workspace.taskSummaries(conversation.id)[0]).toMatchObject({ resumable: true });
  expect(() =>
    f.runtime.enqueue(conversation.id, 'again', '제목을 바꿔줘', undefined, undefined, stopped.id)
  ).toThrow('HELPER_EFFECTS_ALREADY_COMMITTED');

  const resumed = resume('resume', stopped.id);
  await Promise.all(f.work);
  expect(f.workspace.task(resumed.id), f.workspace.task(resumed.id).error ?? '').toMatchObject({
    status: 'completed',
  });
  expect(requests).toHaveLength(3);
  const first = requests[2];
  expect(first.input.results).toEqual([]);
  expect(first).not.toHaveProperty('opaqueState');
  expect(first.input.task).toBe('제목을 바꿔줘');
  expect(first.stable.contract).toContain('from an earlier task that stopped');
  expect(source(first).continuation).toMatchObject({ reason: 'task-resumed' });
  expect(source(first).completedToolHistory?.events).toMatchObject([
    { callId: 'catalog', name: 'app.tools', args: { query: 'chat' }, denied: false },
    { callId: 'rename', name: 'chat.rename', args: { title: '저장 완료' }, denied: false },
  ]);
  expect(source(first).completedToolHistory?.events[0].result).toEqual(
    (requests[1].input.results as unknown as ToolEvent[])[0].result
  );
  expect(f.store.chat(chat.id).title).toBe('저장 완료');
  expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations').get()).toEqual({ n: 1 });
  expect(source(requests[0])).not.toHaveProperty('continuation');
});

test('a resumed task that stops again carries the whole chain and still refuses a retry from the start', async () => {
  const f = fixture(),
    { conversation, requests, replies, resume, source } = stoppedAfterRename(f);
  const stopped = f.runtime.enqueue(conversation.id, 'first', '제목을 바꿔줘');
  await Promise.all(f.work);
  replies.push({
    ...structuredClone(success),
    status: 'error',
    text: '',
    error: { code: 'HTTP_400' },
  });
  const second = resume('resume-1', stopped.id);
  await Promise.all(f.work);
  expect(f.workspace.task(second.id)).toMatchObject({
    status: 'failed',
    error: 'HTTP_400',
    resumable: true,
    completedEffects: { count: 1 },
  });
  expect(() =>
    f.runtime.enqueue(conversation.id, 'again', '제목을 바꿔줘', undefined, undefined, second.id)
  ).toThrow('HELPER_EFFECTS_ALREADY_COMMITTED');
  expect(() => resume('stale', stopped.id)).toThrow('이미 다시 시도한 요청이에요');

  const third = resume('resume-2', second.id);
  await Promise.all(f.work);
  expect(f.workspace.task(third.id)).toMatchObject({ status: 'completed' });
  expect(
    source(requests.at(-1)!).completedToolHistory?.events.map((event) => event.callId)
  ).toEqual(['catalog', 'rename']);
});

test('a stopped task counts the targets one batch call changed, not the call', async () => {
  const f = fixture();
  const bots = ['하나', '둘'].map(
    (name) => f.store.product.content(fixtureBotInput(`${name} 봇`, '설명')) as Content
  );
  mockSend((_request, _options, index) =>
    index === 0
      ? {
          ...structuredClone(success),
          status: 'tool_calls',
          text: '',
          toolCalls: [
            {
              id: 'batch',
              name: 'app.call',
              arguments: {
                name: 'resource.patchMany',
                arguments: {
                  items: bots.map((bot) => ({
                    kind: 'content',
                    id: bot.id,
                    expectedRevision: bot.revision,
                    changes: [
                      { op: 'set', path: '/package/nativeRisu/card/description', value: '새 설명' },
                    ],
                  })),
                },
              },
            },
          ],
        }
      : { ...structuredClone(success), status: 'error', text: '', error: { code: 'HTTP_400' } }
  );
  const task = f.runtime.enqueue(f.conversation.id, 'batch', '두 봇의 설명을 바꿔줘');
  await Promise.all(f.work);
  expect(
    f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations WHERE task_id=?').get(task.id)
  ).toEqual({ n: 1 });
  expect(f.workspace.task(task.id)).toMatchObject({
    status: 'failed',
    completedEffects: { count: 2 },
  });
  expect(f.workspace.taskSummaries(f.conversation.id)[0]).toMatchObject({
    completedEffects: { count: 2 },
  });
});

test.each([
  ['SAFETY', 'HELPER_RESPONSE_REFUSED:SAFETY'],
  ['I cannot help with that request.', 'HELPER_RESPONSE_REFUSED'],
])('a provider refusal %s ends the task as %s', async (refusal, error) => {
  const f = fixture();
  mockSend(() => ({ ...structuredClone(success), status: 'refused', text: '', refusal }));
  const task = f.runtime.enqueue(f.conversation.id, 'refused', '자료를 알려줘');
  await Promise.all(f.work);
  expect(f.workspace.task(task.id)).toMatchObject({ status: 'failed', error });
});

test('a refused task is retried from the start, and continued once it has saved a change', async () => {
  const refused: transport.ProviderResult = {
    ...structuredClone(success),
    status: 'refused',
    text: '',
    refusal: 'SAFETY',
  };
  const early = fixture();
  setRefusalRetries(early.store, false, 0);
  const answers = [refused];
  mockSend(() => answers.shift() ?? structuredClone(success));
  const first = early.runtime.enqueue(early.conversation.id, 'first', '자료를 알려줘');
  await Promise.all(early.work);
  expect(early.workspace.task(first.id)).toMatchObject({
    status: 'failed',
    error: 'HELPER_RESPONSE_REFUSED:SAFETY',
  });
  const retried = early.runtime.enqueue(
    early.conversation.id,
    'again',
    '자료를 알려줘',
    undefined,
    undefined,
    first.id
  );
  await Promise.all(early.work);
  expect(early.workspace.task(retried.id)).toMatchObject({ status: 'completed' });
  vi.restoreAllMocks();

  const late = fixture(),
    { chat, conversation, replies, resume } = stoppedAfterRename(late);
  setRefusalRetries(late.store, false, 0);
  replies[1] = refused;
  const stopped = late.runtime.enqueue(conversation.id, 'first', '제목을 바꿔줘');
  await Promise.all(late.work);
  expect(late.workspace.task(stopped.id)).toMatchObject({
    status: 'failed',
    error: 'HELPER_RESPONSE_REFUSED:SAFETY',
    resumable: true,
    completedEffects: { count: 1 },
  });
  const continued = resume('resume', stopped.id);
  await Promise.all(late.work);
  expect(late.workspace.task(continued.id)).toMatchObject({ status: 'completed' });
  expect(late.store.chat(chat.id).title).toBe('저장 완료');
  expect(late.store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations').get()).toEqual({
    n: 1,
  });
});

test('a task with no recorded exchange cannot be resumed', async () => {
  const f = fixture();
  mockSend(() => ({
    ...structuredClone(success),
    status: 'error',
    text: '',
    error: { code: 'HTTP_400' },
  }));
  const stopped = f.runtime.enqueue(f.conversation.id, 'first', '자료를 알려줘');
  await Promise.all(f.work);
  expect(f.workspace.task(stopped.id)).not.toHaveProperty('resumable');
  const resume = (previous?: string) =>
    f.runtime.enqueue(
      f.conversation.id,
      'resume',
      '자료를 알려줘',
      undefined,
      undefined,
      previous,
      undefined,
      true,
      undefined,
      { resume: true }
    );
  expect(() => resume(stopped.id)).toThrow('HELPER_RESUME_UNAVAILABLE');
  expect(() => resume()).toThrow('HELPER_RESUME_UNAVAILABLE');
});

test('paged helper messages retain their task outcome outside the recent task window', () => {
  const f = fixture();
  const failed = f.workspace.enqueue(
    f.conversation.id,
    'failed-message',
    '중단된 요청',
    snapshot(f)
  );
  f.workspace.start(failed.id, 'owner');
  f.workspace.finish(failed.id, 'owner', 1, 'failed', '완료되지 않은 응답', 'UNEXPECTED_EOF');
  for (let index = 0; index < 51; index++)
    f.workspace.enqueue(f.conversation.id, `later-${index}`, '나중 요청', snapshot(f));
  expect(f.workspace.taskSummaries(f.conversation.id).some((task) => task.id === failed.id)).toBe(
    false
  );
  expect(
    f.workspace.messages(f.conversation.id).find((message) => message.role === 'assistant')
  ).toMatchObject({
    taskId: failed.id,
    taskStatus: 'failed',
    text: '완료되지 않은 응답',
  });
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
test('a task that outlives its time limit fails with HELPER_TASK_TIMEOUT rather than as cancelled', async () => {
  const f = fixture();
  let release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  mockSend(async (_request, options, index) => {
    if (index === 0) {
      await barrier;
      return structuredClone(success);
    }
    await new Promise<void>((resolve) => {
      if (options.signal.aborted) resolve();
      else options.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return {
      ...structuredClone(success),
      status: 'cancelled',
      text: '',
      error: { code: 'CANCELLED' },
    };
  });
  f.runtime.enqueue(f.conversation.id, 'first', '첫 요청');
  const limited = f.runtime.enqueue(f.conversation.id, 'limited', '오래 걸리는 요청');
  f.store.db
    .prepare(
      "UPDATE helper_tasks SET snapshot=json_set(snapshot,'$.taskTimeoutMinutes',0.0005) WHERE id=?"
    )
    .run(limited.id);
  release();
  await vi.waitFor(
    () => expect(['queued', 'running']).not.toContain(f.workspace.task(limited.id).status),
    { timeout: 6000 }
  );
  await Promise.all(f.work);
  expect(f.workspace.task(limited.id)).toMatchObject({
    status: 'failed',
    error: 'HELPER_TASK_TIMEOUT',
  });
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
  await vi.waitFor(() => expect(f.workspace.task(second.id).status).toBe('completed'), {
    timeout: 6000,
  });
  await Promise.all(f.work);
  expect(calls).toHaveLength(2);
  expect(calls[1].input.history).toEqual([
    expect.objectContaining({ role: 'user', text: '첫 질문' }),
    expect.objectContaining({ role: 'assistant', text: '첫 답변' }),
  ]);
  expect(f.workspace.task(second.id).usage.modelCalls).toBe(1);
});

const providerError = (code: string): transport.ProviderResult => ({
  ...structuredClone(success),
  status: 'error',
  text: '',
  error: { code },
});
function waitingRuntime(f: ReturnType<typeof fixture>) {
  const waits: number[] = [];
  const runtime = new HelperRuntime(f.store, {
    owner: 'provider-retry-test',
    signal: f.controller.signal,
    track: (work) => f.work.push(work),
    streams: f.streams,
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  return { runtime, waits };
}
const attemptCount = (f: ReturnType<typeof fixture>) =>
  (f.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get() as { n: number }).n;

test('a rate-limited or overloaded call is repeated after a wait with the task’s tool results intact', async () => {
  const f = fixture(),
    { runtime, waits } = waitingRuntime(f);
  const requests: transport.ProviderRequest[] = [];
  mockSend((request, _options, index) => {
    requests.push(structuredClone(request));
    if (index === 0)
      return {
        ...structuredClone(success),
        status: 'tool_calls',
        text: '',
        toolCalls: [{ id: 'catalog', name: 'app.tools', arguments: { query: 'resource' } }],
      };
    if (index === 1) return providerError('HTTP_429');
    if (index === 2) return providerError('HTTP_503');
    return structuredClone(success);
  });
  const task = runtime.enqueue(f.conversation.id, 'r', '자료 도구를 알려줘');
  await Promise.all(f.work);
  expect(
    runtime.workspace.task(task.id),
    runtime.workspace.task(task.id).error ?? ''
  ).toMatchObject({ status: 'completed' });
  expect(waits).toEqual([5_000, 20_000]);
  expect(
    f.store.db
      .prepare(
        "SELECT data FROM helper_events WHERE task_id=? AND kind='provider.retry' ORDER BY seq"
      )
      .all(task.id)
      .map((row) => JSON.parse(String(row.data)))
  ).toEqual([
    { attempt: 1, attempts: 3, delayMs: 5_000, code: 'HTTP_429' },
    { attempt: 2, attempts: 3, delayMs: 20_000, code: 'HTTP_503' },
  ]);
  expect(attemptCount(f)).toBe(4);
  expect(requests[1].input.results).toHaveLength(1);
  expect(requests[2].input.results).toEqual(requests[1].input.results);
  expect(requests[3].input.results).toEqual(requests[1].input.results);
});

test.each([
  { code: 'HTTP_429', waits: [5_000, 20_000, 60_000], attempts: 4 },
  { code: 'HTTP_400', waits: [], attempts: 1 },
])(
  'a call that keeps failing with $code ends the task after $attempts attempts',
  async ({ code, waits: expected, attempts }) => {
    const f = fixture(),
      { runtime, waits } = waitingRuntime(f);
    mockSend(() => providerError(code));
    const task = runtime.enqueue(f.conversation.id, 'r', '설명해줘');
    await Promise.all(f.work);
    expect(runtime.workspace.task(task.id)).toMatchObject({ status: 'failed', error: code });
    expect(waits).toEqual(expected);
    expect(attemptCount(f)).toBe(attempts);
  }
);

test('a rate-limited attempt leaves nothing unknown in the task usage', async () => {
  const f = fixture(),
    { runtime } = waitingRuntime(f);
  mockSend((_request, _options, index) =>
    index === 0
      ? {
          ...providerError('HTTP_429'),
          usage: { inputTokens: 0, outputTokens: 0, costUsd: null, raw: null, priceRevision: null },
        }
      : structuredClone(success)
  );
  const task = runtime.enqueue(f.conversation.id, 'r', '설명해줘');
  await Promise.all(f.work);
  expect(runtime.workspace.task(task.id).usage).toMatchObject({ inputTokens: 10, outputTokens: 4 });
  expect(readHelperTaskResults(f.store, task.id).usage.attempts[0]).toMatchObject({
    status: 'error',
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  });
});

const refusedCall = (): transport.ProviderResult => ({
  ...structuredClone(success),
  status: 'refused',
  text: '',
  refusal: 'SAFETY',
});
function setRefusalRetries(store: Store, enabled: boolean, max: number) {
  const { revision, ...defaults } = chatGenerationDefaults(store.db);
  saveChatGenerationDefaults(store, {
    ...defaults,
    expectedRevision: revision,
    autoRefusalRetryEnabled: enabled,
    autoRefusalMaxRetries: max,
  });
}

test('a refused call is sent again at once with the task’s tool results intact', async () => {
  const f = fixture();
  const requests: transport.ProviderRequest[] = [];
  mockSend((request, _options, index) => {
    requests.push(structuredClone(request));
    if (index === 0)
      return {
        ...structuredClone(success),
        status: 'tool_calls',
        text: '',
        toolCalls: [{ id: 'catalog', name: 'app.tools', arguments: { query: 'resource' } }],
      };
    return index < 3 ? refusedCall() : structuredClone(success);
  });
  const task = f.runtime.enqueue(f.conversation.id, 'r', '자료 도구를 알려줘');
  await Promise.all(f.work);
  expect(f.workspace.task(task.id), f.workspace.task(task.id).error ?? '').toMatchObject({
    status: 'completed',
  });
  expect(
    f.store.db
      .prepare(
        "SELECT data FROM helper_events WHERE task_id=? AND kind='provider.retry' ORDER BY seq"
      )
      .all(task.id)
      .map((row) => JSON.parse(String(row.data)))
  ).toEqual([
    { attempt: 1, attempts: 2, delayMs: 0, code: 'HELPER_RESPONSE_REFUSED:SAFETY' },
    { attempt: 2, attempts: 2, delayMs: 0, code: 'HELPER_RESPONSE_REFUSED:SAFETY' },
  ]);
  expect(attemptCount(f)).toBe(4);
  expect(requests[1].input.results).toHaveLength(1);
  expect(requests[3].input.results).toEqual(requests[1].input.results);
});

test.each([
  { enabled: true, max: 2, attempts: 3 },
  { enabled: true, max: 5, attempts: 6 },
  { enabled: true, max: 0, attempts: 1 },
  { enabled: false, max: 2, attempts: 1 },
])(
  'a call that keeps being refused ends the task after $attempts attempts when automatic retry is $enabled with a limit of $max',
  async ({ enabled, max, attempts }) => {
    const f = fixture();
    setRefusalRetries(f.store, enabled, max);
    mockSend(() => refusedCall());
    const task = f.runtime.enqueue(f.conversation.id, 'r', '설명해줘');
    await Promise.all(f.work);
    expect(f.workspace.task(task.id)).toMatchObject({
      status: 'failed',
      error: 'HELPER_RESPONSE_REFUSED:SAFETY',
    });
    expect(attemptCount(f)).toBe(attempts);
  }
);

test('each refused call gets its own retries within one task', async () => {
  const f = fixture();
  setRefusalRetries(f.store, true, 1);
  const replies = [
    refusedCall(),
    {
      ...structuredClone(success),
      status: 'tool_calls' as const,
      text: '',
      toolCalls: [{ id: 'catalog', name: 'app.tools', arguments: { query: 'resource' } }],
    },
    refusedCall(),
  ];
  mockSend(() => replies.shift() ?? structuredClone(success));
  const task = f.runtime.enqueue(f.conversation.id, 'r', '자료 도구를 알려줘');
  await Promise.all(f.work);
  expect(f.workspace.task(task.id), f.workspace.task(task.id).error ?? '').toMatchObject({
    status: 'completed',
  });
  expect(attemptCount(f)).toBe(4);
});

function useGeminiHelper(f: ReturnType<typeof fixture>) {
  const connection = f.store.product.connection({
    title: 'Synthetic Gemini',
    protocol: 'vertex-gemini-v1',
    endpoint:
      'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models',
    apiKey: 'SYNTHETIC_VERTEX_TOKEN',
    enabled: true,
  });
  const model = f.store.product.model({
    title: 'Synthetic Gemini',
    connectionId: connection.id,
    modelId: 'gemini-4-carbon',
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
}

test('a Gemini helper call asks for thought summaries, shows them while it runs and drops them when it ends', async () => {
  const f = fixture();
  useGeminiHelper(f);
  let taskId = '';
  const seen: (string | undefined)[] = [];
  mockSend(async (request, options, index) => {
    expect(request.thoughtSummary).toBe(true);
    seen.push(f.streams.read('helper', taskId).thought);
    await options.onThought?.(index === 0 ? '자료를 확인하는 중' : '답변을 정리하는 중');
    seen.push(f.streams.read('helper', taskId).thought);
    return index === 0 ? refusedCall() : structuredClone(success);
  });
  taskId = f.runtime.enqueue(f.conversation.id, 'r', '자료 도구를 알려줘').id;
  await Promise.all(f.work);
  expect(f.workspace.task(taskId), f.workspace.task(taskId).error ?? '').toMatchObject({
    status: 'completed',
  });
  expect(seen).toEqual([undefined, '자료를 확인하는 중', undefined, '답변을 정리하는 중']);
  expect(
    f.store.db
      .prepare("SELECT COUNT(*) AS n FROM helper_events WHERE task_id=? AND data LIKE '%정리하는%'")
      .get(taskId)
  ).toEqual({ n: 0 });
});

test.each([{ later: 'completed' }, { later: 'HTTP_400' }] as const)(
  'a Gemini call rejected with HTTP 400 is sent once more without thought summaries, then ends $later',
  async ({ later }) => {
    const f = fixture();
    useGeminiHelper(f);
    const asked: (true | undefined)[] = [];
    mockSend((request, _options, index) => {
      asked.push(request.thoughtSummary);
      return index === 0 || later === 'HTTP_400'
        ? providerError('HTTP_400')
        : structuredClone(success);
    });
    const task = f.runtime.enqueue(f.conversation.id, 'r', '자료 도구를 알려줘');
    await Promise.all(f.work);
    expect(f.workspace.task(task.id)).toMatchObject(
      later === 'completed' ? { status: 'completed' } : { status: 'failed', error: 'HTTP_400' }
    );
    expect(asked).toEqual([true, undefined]);
    expect(attemptCount(f)).toBe(2);
  }
);

test('a refused native Codex turn is not sent again', async () => {
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
  let turns = 0;
  const runtime = new HelperRuntime(f.store, {
    owner: 'native-refusal-test',
    signal: f.controller.signal,
    track: (work) => f.work.push(work),
    streams: f.streams,
    executeCodexAgent: async () => {
      turns++;
      return refusedCall();
    },
  });
  const conversation = runtime.workspace.open({ kind: 'library', workId: 'native' });
  const task = runtime.enqueue(conversation.id, 'native-refused', '설명해줘');
  await Promise.all(f.work);
  expect(runtime.workspace.task(task.id)).toMatchObject({
    status: 'failed',
    error: 'HELPER_RESPONSE_REFUSED:SAFETY',
  });
  expect(turns).toBe(1);
});

test('a wait before repeating a call ends at once when the user stops the task', async () => {
  const f = fixture();
  mockSend(() => providerError('HTTP_429'));
  const task = f.runtime.enqueue(f.conversation.id, 'r', '설명해줘');
  await vi.waitFor(() =>
    expect(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE status='error'").get()
    ).toEqual({ n: 1 })
  );
  f.runtime.cancel(task.id);
  await vi.waitFor(() => expect(f.workspace.task(task.id).status).toBe('cancelled'), {
    timeout: 2000,
  });
  await Promise.all(f.work);
  expect(attemptCount(f)).toBe(1);
});

test('helper retries retain attempts but project the latest response at the original request position', async () => {
  const f = fixture();
  mockSend((_request, _options, index) =>
    index < 2 ? providerError('HTTP_400') : structuredClone(success)
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

test('copy preserves the visible retry order across message pages without restoring superseded attempts', async () => {
  const f = fixture();
  const add = f.store.db.prepare('INSERT INTO helper_seed_messages VALUES(?,?,?,?,?,?)');
  for (let i = 0; i < 102; i++)
    add.run(
      crypto.randomUUID(),
      f.conversation.id,
      i,
      i % 2 ? 'assistant' : 'user',
      `이전 ${i}`,
      new Date().toISOString()
    );
  mockSend((_request, _options, index) =>
    index === 0
      ? providerError('HTTP_400')
      : { ...structuredClone(success), text: index === 1 ? '둘째 답변' : '재시도 답변' }
  );
  const first = f.runtime.enqueue(f.conversation.id, 'retry-source', '이전 요청');
  await Promise.all(f.work);
  f.runtime.enqueue(f.conversation.id, 'later-request', '둘째 요청');
  await Promise.all(f.work);
  f.runtime.enqueue(f.conversation.id, 'retry-later', '고친 요청', undefined, undefined, first.id);
  await Promise.all(f.work);
  const copy = f.workspace.copy(
    f.conversation.id,
    'copy-retry',
    f.workspace.deletionImpact(f.conversation.id).request
  );
  const copied = helperHistory(f.store, copy.id).map((message) => message.text);
  expect(copied).toHaveLength(106);
  expect(copied.slice(0, 102)).toEqual(Array.from({ length: 102 }, (_, i) => `이전 ${i}`));
  expect(copied.slice(102)).toEqual(['고친 요청', '재시도 답변', '둘째 요청', '둘째 답변']);
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
  await vi.waitFor(() => expect(f.workspace.task(a2.id).status).toBe('completed'), {
    timeout: 6000,
  });
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
  expect(other.persona).toBe(UI_HELPER_PERSONA);
  const disabled = f.workspace.persona(other.id, other.revision, '');
  expect(disabled.persona).toBe('');
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
    expect(request.stable.tools.map((tool) => tool.name)).toEqual(['app.tools', 'app.call']);
    if (index === 0)
      return {
        ...structuredClone(success),
        status: 'tool_calls',
        text: '',
        toolCalls: [
          {
            id: 'read-evidence',
            name: 'app.call',
            arguments: {
              name: 'data.search',
              arguments: { scope: 'current', ids: [source.id], patterns: ['Mira'] },
            },
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
    { name: 'app.call', args: { name: 'data.search' }, denied: false },
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
  expect(f.workspace.messages(conversation.id).at(-1)).toMatchObject({
    role: 'assistant',
    taskId: task.id,
  });
  expect(
    f.store.db.prepare('SELECT count(*) AS n FROM outline_reviews WHERE task_id=?').get(task.id)?.n
  ).toBe(0);
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

test('existing helper branch seeds remain readable and usable after source deletion', async () => {
  const f = fixture();
  const source = f.conversation;
  const branched = f.workspace.create(source.scope, 'legacy-branch', '기존 분기');
  const add = f.store.db.prepare(`INSERT INTO helper_seed_messages
    (id,conversation_id,ordinal,role,text,created_at) VALUES(?,?,?,?,?,?)`);
  const time = new Date().toISOString();
  add.run(crypto.randomUUID(), branched.id, 0, 'user', '초기 질문', time);
  add.run(crypto.randomUUID(), branched.id, 1, 'assistant', '초기 답변', time);
  f.workspace.delete(source.id, f.workspace.deletionImpact(source.id).request);
  expect(f.workspace.messages(branched.id).map((message) => message.text)).toEqual([
    '초기 질문',
    '초기 답변',
  ]);
  expect(helperHistory(f.store, branched.id).map((message) => message.text)).toEqual([
    '초기 질문',
    '초기 답변',
  ]);
  const requests: transport.ProviderRequest[] = [];
  mockSend((request) => {
    requests.push(structuredClone(request));
    return structuredClone(success);
  });
  const task = f.runtime.enqueue(branched.id, 'continue-seed', '이어서 답해줘');
  await Promise.all(f.work);
  expect(f.workspace.task(task.id).status).toBe('completed');
  expect(requests[0].input.history).toMatchObject([
    { role: 'user', text: '초기 질문' },
    { role: 'assistant', text: '초기 답변' },
  ]);
});

test('helper copies keep the visible transcript and explicit project without copying tasks or usage', async () => {
  const f = fixture();
  const saved = f.store.product.content(fixtureBotInput('분류할 봇'));
  mockSend(() => structuredClone(success));
  const task = f.runtime.enqueue(f.conversation.id, 'copy-source', '첫 질문', {
    kind: 'content',
    source: 'saved',
    targetId: saved.id,
    revision: saved.revision,
    title: saved.title,
  });
  await Promise.all(f.work);
  expect(f.workspace.task(task.id).snapshot.editor).toBeUndefined();
  expect(
    f.workspace.list({ kind: 'all' }).find((row) => row.id === f.conversation.id)?.projectId
  ).toBeNull();
  const project = f.workspace.createGroup('내 프로젝트', 'create-project');
  f.workspace.moveGroup(
    f.conversation.id,
    f.workspace.conversation(f.conversation.id).revision,
    project.id
  );
  const source = f.workspace.conversation(f.conversation.id);
  const edited = f.workspace.editMessage(
    source.id,
    f.workspace.messages(source.id)[0].id,
    source.revision,
    '고친 질문'
  );
  const expected = f.workspace.deletionImpact(source.id).request;
  const copy = f.workspace.copy(source.id, 'copy-key', expected);
  expect(f.workspace.copy(source.id, 'copy-key', expected).id).toBe(copy.id);
  expect(() =>
    f.workspace.copy(source.id, 'copy-key', {
      ...expected,
      expectedRevision: edited.conversation.revision + 1,
    })
  ).toThrow();
  expect(f.workspace.messages(copy.id).map((m) => m.text)).toEqual(['고친 질문', '완료했어요.']);
  expect(f.workspace.taskSummaries(copy.id)).toEqual([]);
  expect(f.workspace.list({ kind: 'all' }).find((row) => row.id === copy.id)?.projectId).toBe(
    project.id
  );
  f.workspace.delete(source.id, expected);
  expect(helperHistory(f.store, copy.id).map((m) => m.text)).toEqual(['고친 질문', '완료했어요.']);
});

test('project changes are explicit and deleting a project preserves conversations and their execution scope', () => {
  const f = fixture();
  const project = f.workspace.createGroup('작품', 'project-key');
  expect(f.workspace.createGroup('작품', 'project-key')).toEqual(project);
  expect(() => f.workspace.createGroup('다른 이름', 'project-key')).toThrow();
  const original = f.workspace.conversation(f.conversation.id);
  const moved = f.workspace.moveGroup(original.id, original.revision, project.id);
  expect(moved.scope).toEqual(original.scope);
  expect(() => f.workspace.moveGroup(original.id, original.revision, null)).toThrow();
  const renamed = f.workspace.renameGroup(project.id, project.revision, '새 이름');
  expect(() => f.workspace.deleteGroup(project.id, project.revision)).toThrow();
  f.workspace.deleteGroup(project.id, renamed.revision);
  expect(f.workspace.conversation(original.id).scope).toEqual(original.scope);
  expect(
    f.workspace.list({ kind: 'all' }).find((item) => item.id === original.id)?.projectId
  ).toBeNull();
  expect(f.workspace.conversation(original.id).revision).toBe(moved.revision + 1);
});

test('message editing changes future dialogue while preserving task evidence, effects and checkpoint history', async () => {
  const f = fixture();
  const task = f.workspace.enqueue(f.conversation.id, 'original', '원래 요청', snapshot(f));
  f.workspace.start(task.id, 'owner');
  const checkpoint = publishHelperContext(
    f.store,
    f.workspace.task(task.id),
    '원래 요약',
    { modelCalls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
    10,
    { activeRevision: 0, checkpoint: null }
  );
  f.workspace.operation(task.id, 'durable-effect', {}, () => ({ saved: true }));
  f.workspace.finish(task.id, 'owner', 1, 'failed', '원래 답변', 'UNEXPECTED_EOF');
  const originalTask = f.workspace.task(task.id);
  const messages = f.workspace.messages(f.conversation.id);
  const app = Fastify();
  helperRoutes(app, f.runtime);
  try {
    let revision = f.workspace.conversation(f.conversation.id).revision;
    for (const [message, text] of [
      [messages[0], '고친 요청'],
      [messages[1], '고친 답변'],
    ] as const) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/helper/conversations/${f.conversation.id}/messages/${message.id}`,
        payload: { expectedRevision: revision, text },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        updatedMessage: { id: message.id, text },
        conversation: { revision: revision + 1 },
      });
      expect(response.json().conversation.historyRevision).toBeGreaterThan(0);
      revision++;
    }
    expect(f.workspace.messages(f.conversation.id).map((message) => message.text)).toEqual([
      '고친 요청',
      '고친 답변',
    ]);
    expect(helperHistory(f.store, f.conversation.id).map((message) => message.text)).toEqual([
      '고친 요청',
      '고친 답변',
    ]);
    expect(
      helperContext(f.store, f.conversation.id, helperHistory(f.store, f.conversation.id))
    ).toMatchObject({ checkpoint: null });
    expect(f.store.context.checkpoint(checkpoint.checkpoint).plan.summary).toBe('원래 요약');
    expect(f.workspace.task(task.id)).toEqual(originalTask);
    const updates = await app.inject({
      method: 'GET',
      url: `/api/helper/conversations/${f.conversation.id}/events`,
    });
    expect(updates.statusCode).toBe(200);
    expect(
      updates.json().filter((event: { kind: string }) => event.kind === 'messages.changed')
    ).toMatchObject([
      {
        data: { revision: revision - 1, updatedMessage: { id: messages[0].id, text: '고친 요청' } },
      },
      { data: { revision, updatedMessage: { id: messages[1].id, text: '고친 답변' } } },
    ]);
    expect(
      updates
        .json()
        .filter((event: { kind: string }) => event.kind !== 'messages.changed')
        .every((event: { data: unknown }) => event.data === null)
    ).toBe(true);
    expect(
      f.store.db.prepare('SELECT text FROM helper_messages WHERE id=?').get(messages[0].id)?.text
    ).toBe('원래 요청');
    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/helper/conversations/${f.conversation.id}/messages/${messages[0].id}`,
      payload: { expectedRevision: revision - 1, text: '덮어쓰기' },
    });
    expect(stale.statusCode).toBe(409);
    const other = f.workspace.create(f.conversation.scope, 'other');
    const foreign = await app.inject({
      method: 'PATCH',
      url: `/api/helper/conversations/${other.id}/messages/${messages[0].id}`,
      payload: { expectedRevision: other.revision, text: '다른 대화' },
    });
    expect(foreign.statusCode).toBe(404);
    const owner = owned.find((item) => item.store === f.store)!;
    f.store.close();
    owner.store = new Store(join(owner.path, 'story.sqlite'));
    expect(
      new HelperWorkspace(owner.store).messages(f.conversation.id).map((message) => message.text)
    ).toEqual(['고친 요청', '고친 답변']);
  } finally {
    await app.close();
  }
});

test('pair deletion hides every retry attempt without deleting task evidence or allowing resurrection', () => {
  const f = fixture();
  const first = f.workspace.enqueue(f.conversation.id, 'first', '첫 요청', snapshot(f));
  f.workspace.start(first.id, 'owner');
  f.workspace.finish(first.id, 'owner', 1, 'failed', '미완성 답변', 'UNEXPECTED_EOF');
  const retry = f.workspace.enqueue(f.conversation.id, 'retry', '다시 요청', {
    ...snapshot(f),
    retryOf: first.id,
  });
  f.workspace.cancel(retry.id);
  const later = f.workspace.enqueue(f.conversation.id, 'later', '다음 요청', snapshot(f));
  f.workspace.start(later.id, 'owner');
  f.workspace.finish(later.id, 'owner', 1, 'completed', '다음 답변', null);
  const messages = f.workspace.messages(f.conversation.id);
  const removedIds = messages
    .filter((message) => message.requestGroupId === first.id)
    .map((message) => message.id);
  const selected = messages.find((message) => message.taskId === retry.id)!;
  const result = f.runtime.deleteMessages(
    f.conversation.id,
    selected.id,
    f.workspace.conversation(f.conversation.id).revision,
    'pair'
  );
  expect(new Set(result.deletedMessageIds)).toEqual(new Set(removedIds));
  expect(f.workspace.messages(f.conversation.id).map((message) => message.text)).toEqual([
    '다음 요청',
    '다음 답변',
  ]);
  expect(helperHistory(f.store, f.conversation.id).map((message) => message.text)).toEqual([
    '다음 요청',
    '다음 답변',
  ]);
  expect(f.workspace.taskSummaries(f.conversation.id)).toHaveLength(3);
  expect(() =>
    f.workspace.enqueue(f.conversation.id, 'revive', '다시 요청', {
      ...snapshot(f),
      retryOf: retry.id,
    })
  ).toThrow('삭제한 도우미 요청');
  expect(() =>
    f.runtime.enqueue(
      f.conversation.id,
      'runtime-revive',
      '다시 요청',
      undefined,
      undefined,
      retry.id
    )
  ).toThrow('삭제한 도우미 요청');
});

test('seed edits and following deletion use request chronology rather than retry insertion order', () => {
  const f = fixture();
  const add = f.store.db.prepare('INSERT INTO helper_seed_messages VALUES(?,?,?,?,?,?)');
  const time = new Date().toISOString();
  for (const [ordinal, role, text] of [
    [0, 'user', '시드 요청'],
    [1, 'assistant', '시드 답변'],
    [2, 'user', '나중 시드 요청'],
    [3, 'assistant', '나중 시드 답변'],
  ] as const)
    add.run(`seed-${ordinal}`, f.conversation.id, ordinal, role, text, time);
  const first = f.workspace.enqueue(f.conversation.id, 'first', '먼저 보낸 요청', snapshot(f));
  f.workspace.cancel(first.id);
  const second = f.workspace.enqueue(f.conversation.id, 'second', '뒤에 보낸 요청', snapshot(f));
  f.workspace.cancel(second.id);
  const retry = f.workspace.enqueue(f.conversation.id, 'retry', '먼저 보낸 요청 재시도', {
    ...snapshot(f),
    retryOf: first.id,
  });
  f.workspace.cancel(retry.id);
  const edited = f.workspace.editMessage(
    f.conversation.id,
    'seed-1',
    f.workspace.conversation(f.conversation.id).revision,
    '고친 시드 답변'
  );
  expect(helperHistory(f.store, f.conversation.id)[1].text).toBe('고친 시드 답변');
  const selected = f.workspace
    .messages(f.conversation.id)
    .find((message) => message.taskId === second.id)!;
  const deleted = f.workspace.deleteMessages(
    f.conversation.id,
    selected.id,
    edited.conversation.revision,
    'following'
  );
  expect(deleted.deletedMessageIds).toEqual([selected.id]);
  expect(
    f.workspace.messages(f.conversation.id).some((message) => message.taskId === retry.id)
  ).toBe(true);
  const seeds = f.workspace.deleteMessages(
    f.conversation.id,
    'seed-1',
    deleted.conversation.revision,
    'pair'
  );
  expect(new Set(seeds.deletedMessageIds)).toEqual(new Set(['seed-0', 'seed-1']));
  const tail = f.workspace.deleteMessages(
    f.conversation.id,
    'seed-3',
    seeds.conversation.revision,
    'following'
  );
  expect(tail.deletedMessageIds).toContain('seed-2');
  expect(f.workspace.messages(f.conversation.id)).toEqual([]);
  expect(helperHistory(f.store, f.conversation.id)).toEqual([]);
});

test('message changes block only activity in their conversation, including unsettled provider work', () => {
  const f = fixture();
  const task = f.workspace.enqueue(f.conversation.id, 'first', '요청', snapshot(f));
  const message = f.workspace.messages(f.conversation.id)[0];
  const revision = f.workspace.conversation(f.conversation.id).revision;
  expect(() => f.runtime.editMessage(f.conversation.id, message.id, revision, '변경')).toThrow(
    '진행 중인 작업'
  );
  f.workspace.start(task.id, 'owner');
  const attempt = f.workspace.startAttempt(task.id, 'owner', 1, 'helper', 0, {
    connectionId: 'test',
    protocol: 'fixture-sse-v1',
    role: 'helper',
    modelId: 'test',
    method: 'POST',
    url: 'http://127.0.0.1:9',
    headers: {},
    body: {},
    bodySha256: 'test',
    stablePrefixSha256: 'test',
  });
  f.workspace.cancel(task.id);
  expect(() => f.runtime.deleteMessages(f.conversation.id, message.id, revision, 'pair')).toThrow(
    '진행 중인 작업'
  );
  f.workspace.finishAttempt(task.id, attempt, success);
  const other = f.workspace.create(f.conversation.scope, 'other');
  f.workspace.enqueue(other.id, 'active-elsewhere', '다른 대화 요청', {
    ...snapshot(f),
    scope: other.scope,
  });
  expect(
    f.runtime.editMessage(f.conversation.id, message.id, revision, '변경').updatedMessage?.text
  ).toBe('변경');
});

test('a new request invalidates an older delete confirmation but duplicate admission does not', () => {
  const f = fixture();
  const first = f.workspace.enqueue(f.conversation.id, 'first', '첫 요청', snapshot(f));
  f.workspace.cancel(first.id);
  const message = f.workspace.messages(f.conversation.id)[0];
  const revision = f.workspace.conversation(f.conversation.id).revision;
  const second = f.workspace.enqueue(f.conversation.id, 'second', '새 요청', snapshot(f));
  f.workspace.cancel(second.id);
  expect(f.workspace.conversation(f.conversation.id).revision).toBe(revision + 1);
  expect(f.workspace.enqueue(f.conversation.id, 'second', '새 요청', snapshot(f)).id).toBe(
    second.id
  );
  expect(f.workspace.conversation(f.conversation.id).revision).toBe(revision + 1);
  expect(() =>
    f.workspace.deleteMessages(f.conversation.id, message.id, revision, 'following')
  ).toThrow('대화가 변경됐어요');
  expect(f.workspace.messages(f.conversation.id)).toHaveLength(2);
});
