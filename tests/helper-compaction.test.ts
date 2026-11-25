import { VERTEX_GEMINI_MODEL_ID } from './fixtures/vertex-model.js';
import * as resourceTools from '../server/helper-resource-tools.js';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { HelperRuntime } from '../server/helper-runtime.js';
import { ResponseStreamStore } from '../server/response-stream.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { publishHelperContext, readHelperContextState } from '../server/helper-context.js';
import { encodeMainPreview } from '../server/main-request.js';
import * as mainRequest from '../server/main-request.js';
import * as helperAttachments from '../server/helper-attachments.js';
import { helperRoutes } from '../server/helper-routes.js';
import Fastify from 'fastify';
import { HELPER_PROVIDER_RETRY_DELAYS_MS } from '../core/helper.js';
import { assertContextBudget, estimateContextTokens } from '../core/context-budget.js';
import { countTextTokens } from '../core/text-tokens.js';
import { decodeAnthropicMessage, encodeAnthropic } from '../core/anthropic-protocol.js';
import {
  CONTEXT_CONTINUATION_GUIDANCE,
  CONTEXT_RETRIEVAL_GUIDANCE,
} from '../core/context-summary-policy.js';
import { generationFromModel } from '../core/model-capabilities.js';
import { editableResource } from '../core/resource-editing.js';
import { type Content, type ModelPreset, type ModelSnapshot } from '../core/product.js';
import type { HelperEditor, HelperTask } from '../core/helper.js';
import type { ToolEvent } from '../core/types.js';
import * as transport from '../core/transport.js';
import { fixtureBotInput } from './fixtures/chat.js';

const origin = 'http://127.0.0.1:44997';
const vertexOrigin = 'https://aiplatform.googleapis.com';
const owned: { store: Store; path: string; controller: AbortController; work: Promise<void>[] }[] =
  [];
afterEach(async () => {
  for (const { store, path, controller, work } of owned.splice(0)) {
    controller.abort();
    await Promise.allSettled(work);
    store.close();
    const inside = relative(tmpdir(), path);
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !inside.startsWith('uimori-helper-compact-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const success: transport.ProviderResult = {
  status: 'completed',
  text: '완료 결과를 확인했어요.',
  toolCalls: [],
  refusal: null,
  error: null,
  usage: { inputTokens: 11, outputTokens: 7, costUsd: null, raw: null, priceRevision: null },
  opaqueState: null,
};
const summaryText = '검토한 문서의 약속은 아직 이행 여부가 확인되지 않았다.';
const readText = 'Separate participants, exact conditions and unresolved promises. '.repeat(80);
const expandedSummary =
  'Expanded summary retains every unrelated statement and explanation. '.repeat(450);
const tool = (id: string, name: string, args: Record<string, transport.Json>) => ({
  id,
  name,
  arguments: args,
});
const tools = (...toolCalls: transport.ProviderToolCall[]): transport.ProviderResult => ({
  ...structuredClone(success),
  status: 'tool_calls',
  text: '',
  toolCalls,
});
const summarized = (text = summaryText): transport.ProviderResult => ({
  ...structuredClone(success),
  text,
});
const eventStream = (...parts: unknown[]) =>
  new Response(parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
const vertexReply = (parts: unknown[]) =>
  eventStream({
    candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 },
  });
async function fixture(
  options: {
    vertex?: boolean;
    fixed?: boolean;
    reviewOnly?: boolean;
    wait?: (ms: number, signal: AbortSignal) => Promise<unknown>;
  } = {}
) {
  const path = mkdtempSync(join(tmpdir(), 'uimori-helper-compact-')),
    store = new Store(join(path, 'story.sqlite')),
    controller = new AbortController(),
    work: Promise<void>[] = [];
  owned.push({ store, path, controller, work });
  const connection = store.product.connection({
    title: 'Synthetic helper',
    protocol: options.vertex ? 'vertex-gemini-v1' : 'fixture-sse-v1',
    endpoint: options.vertex
      ? `${vertexOrigin}/v1/projects/synthetic-project/locations/global/publishers/google/models`
      : origin,
    ...(options.vertex ? { apiKey: 'SYNTHETIC_VERTEX_TOKEN' } : {}),
    enabled: true,
  });
  const contextConnection = store.product.connection({
    title: 'Synthetic context',
    protocol: 'fixture-sse-v1',
    endpoint: origin,
    enabled: true,
  });
  const helperModel = store.product.model({
    title: 'Synthetic helper',
    connectionId: connection.id,
    modelId: options.vertex ? VERTEX_GEMINI_MODEL_ID : 'fixture-helper',
    temperature: null,
    maxOutputTokens: 1024,
    inputTokenLimit: options.fixed === false ? 8192 : 65536,
  });
  const contextModel = store.product.model({
    title: 'Synthetic context',
    connectionId: contextConnection.id,
    modelId: 'fixture-context',
    temperature: null,
    maxOutputTokens: 8192,
    inputTokenLimit: 65536,
  });
  const selected = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: selected.revision,
    routes: selected.routes,
    translationPolicy: selected.translationPolicy,
    helperModel: { id: helperModel.id },
    contextModel: { id: contextModel.id },
  });
  const runtime = new HelperRuntime(store, {
    resolveCredential: () => 'SYNTHETIC_VERTEX_TOKEN',
    owner: 'helper-compaction-owner',
    signal: controller.signal,
    track: (promise) => work.push(promise),
    streams: new ResponseStreamStore(store),
    ...(options.wait ? { wait: options.wait } : {}),
  });
  const workspace = runtime.workspace;
  const saved = store.product.content(fixtureBotInput('Original synthetic content')) as Content;
  const editor: HelperEditor = {
    targetId: saved.id,
    revision: 1,
    kind: 'content',
    title: 'Synthetic draft',
  };
  const request =
    (options.reviewOnly ? '현재 초안을 검토하고 제안만 해줘.' : '현재 초안을 수정하고 저장해줘.') +
    (options.fixed === false
      ? ''
      : '\n' + 'Keep this fixed user constraint and its exact meaning. '.repeat(1200));
  const f = {
    store,
    runtime,
    workspace,
    connection,
    contextConnection,
    helperModel,
    contextModel,
    saved,
    editor,
    request,
    work,
    controller,
    conversation: workspace.open({ kind: 'library', workId: 'calibration' }),
    readValue: { revision: 1, text: readText } as Record<string, transport.Json>,
    receiptPadding: '',
    mutations: 0,
    currentTaskId: '',
    async run() {
      const task = runtime.enqueue(f.conversation.id, randomUUID(), request, editor);
      f.currentTaskId = task.id;
      await Promise.all(work);
      return workspace.task(task.id);
    },
    target(role: transport.ProviderRequest['role']) {
      return store.product.modelSnapshot(role === 'context' ? contextModel.id : helperModel.id);
    },
    updateModel(id: string, changes: Partial<ModelPreset>) {
      const prior = store.product.get<ModelPreset>('model', id);
      store.product.model(
        {
          title: prior.title,
          connectionId: prior.connectionId,
          modelId: prior.modelId,
          ...generationFromModel(prior),
          inputTokenLimit: prior.inputTokenLimit,
          ...changes,
          expectedRevision: prior.revision,
        },
        id
      );
    },
  };
  vi.spyOn(resourceTools, 'invokeResourceTool').mockImplementation((_store, name, args) => {
    if (name === 'resource.read' || name === 'resource.readMany')
      return structuredClone(f.readValue);
    const current = store.product.content(
      { ...fixtureBotInput('Saved exactly once'), expectedRevision: args.expectedRevision },
      saved.id
    ) as Content;
    f.mutations++;
    return {
      status: 'saved',
      id: current.id,
      revision: current.revision,
      payload: f.receiptPadding,
    };
  });
  if (options.fixed !== false) {
    const calibration = script(f, () => structuredClone(success));
    expect((await f.run()).status).toBe('completed');
    const measured = estimateContextTokens(
      encodeMainPreview(calibration.requests[0], f.target('helper')).body
    );
    calibration.spy.mockRestore();
    f.updateModel(helperModel.id, { inputTokenLimit: Math.ceil(measured / 0.86) });
  }
  f.conversation = workspace.open({ kind: 'library', workId: 'case' });
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function script(
  f: { target: (role: transport.ProviderRequest['role']) => ModelSnapshot },
  action: (
    request: transport.ProviderRequest,
    index: number
  ) => transport.ProviderResult | Promise<transport.ProviderResult>
) {
  const requests: transport.ProviderRequest[] = [];
  const spy = vi
    .spyOn(transport, 'executeProvider')
    .mockImplementation(async (connection, request, options) => {
      transport.validateConnection(connection);
      const body = encodeMainPreview(request, f.target(request.role)).body;
      assertContextBudget(body, request.contextBudget);
      options.beforeTurn?.();
      await options.onWire?.({
        connectionId: connection.id,
        protocol: connection.protocol,
        role: request.role,
        modelId: request.modelId,
        method: 'POST',
        url: connection.endpoint,
        headers: {},
        body,
        bodySha256: 'synthetic',
        stablePrefixSha256: 'synthetic',
      });
      requests.push(structuredClone(request));
      return action(request, requests.length - 1);
    });
  return { requests, spy };
}
function compactions(f: Fixture, task: HelperTask) {
  return f.workspace
    .events(f.conversation.id)
    .filter((event) => event.taskId === task.id && event.kind === 'context.compaction')
    .map(
      (event) =>
        event.data as {
          applied: boolean;
          beforeTokens: number;
          afterTokens: number;
          preservedExchanges: number;
        }
    );
}
function checkpointRows(f: Fixture) {
  return f.store.db
    .prepare('SELECT * FROM context_checkpoints WHERE scope_key=? ORDER BY rowid')
    .all(`helper:${f.conversation.id}`);
}
function events(request: transport.ProviderRequest): ToolEvent[] {
  return request.input.results as unknown as ToolEvent[];
}
function carried(request: transport.ProviderRequest): ToolEvent[] {
  const source = request.input.source as Record<string, transport.Json>;
  return (
    (source.completedToolHistory as unknown as { events: ToolEvent[] } | undefined)?.events ?? []
  );
}
function continuation(request: transport.ProviderRequest) {
  return (request.input.source as Record<string, transport.Json>).continuation as unknown as
    | {
        kind: string;
        taskId: string;
        conversationId: string;
        segment: number;
        status: string;
        reason: string;
        completedReads: { name: string; args: Record<string, transport.Json>; returned?: any }[];
      }
    | undefined;
}

test('large-model helper preserves repeated exact evidence while below the context pressure threshold', async () => {
  const f = await fixture({ fixed: false });
  f.updateModel(f.helperModel.id, { inputTokenLimit: 272_000 });
  const sentence =
    'Distinct appearance trait and original source evidence, preserved for later inspection. ';
  f.readValue = {
    revision: 1,
    text: sentence.repeat(Math.ceil(53_000 / countTextTokens(sentence))),
  };
  let helperCalls = 0;
  const log = script(f, (request) => {
    expect(request.role).toBe('helper');
    if (++helperCalls === 1)
      return tools(
        tool('large-evidence', 'resource.read', { kind: 'content', id: 'large-evidence' })
      );
    if (helperCalls === 2) {
      expect(events(request).some((event) => event.callId === 'large-evidence')).toBe(true);
      expect(continuation(request)).toBeUndefined();
      return tools(tool('invalid-catalog', 'app.tools', { names: [] }));
    }
    expect(continuation(request)).toBeUndefined();
    expect(events(request).find((event) => event.callId === 'large-evidence')?.result).toEqual(
      f.readValue
    );
    return structuredClone(success);
  });
  const task = await f.run();
  expect(task.status, task.error ?? '').toBe('completed');
  expect(log.requests[0].role).toBe('helper');
  expect(log.requests.at(-1)?.role).toBe('helper');
  expect(log.requests).toHaveLength(3);
  expect(compactions(f, task)).toEqual([]);
});

test('a fitting recent turn does not spend a summary call when nothing older can be compacted', async () => {
  const f = await fixture();
  const log = script(f, (request) => {
    expect(request.role).toBe('helper');
    return structuredClone(success);
  });
  const previous = f.runtime.enqueue(f.conversation.id, randomUUID(), '이름은 바꾸지 마.');
  await Promise.all(f.work);
  expect(f.workspace.task(previous.id).status).toBe('completed');
  const task = await f.run();
  expect(task, task.error ?? '').toMatchObject({ status: 'completed', usage: { modelCalls: 1 } });
  expect(log.requests.at(-1)?.input.history).toEqual(
    expect.arrayContaining([expect.objectContaining({ role: 'user', text: '이름은 바꾸지 마.' })])
  );
  expect(compactions(f, task)).toEqual([]);
});

test('oversized write-only Anthropic continuation with recent history starts a fitting segment without a summary model', async () => {
  const f = await fixture({ fixed: false });
  const seed = script(f, () => structuredClone(success));
  const previous = f.runtime.enqueue(f.conversation.id, randomUUID(), '이름은 바꾸지 마.');
  await Promise.all(f.work);
  expect(f.workspace.task(previous.id).status).toBe('completed');
  seed.spy.mockRestore();
  const recent = f.workspace
    .messages(f.conversation.id)
    .map(({ id, role, text }) => ({ id, role, text }));
  const connection = f.store.product.connection({
    title: 'Synthetic Anthropic helper',
    protocol: 'anthropic-messages-v1',
    endpoint: 'https://api.anthropic.com/v1/messages',
    apiKey: 'SYNTHETIC_ANTHROPIC_TOKEN',
    enabled: true,
  });
  f.updateModel(f.helperModel.id, {
    connectionId: connection.id,
    modelId: 'claude-sonnet-4-20250514',
    maxOutputTokens: 8192,
    tokenizer: 'openai-o200k',
  });
  const selected = modelWorkspace(f.store);
  updateModelWorkspace(f.store, {
    expectedRevision: selected.revision,
    routes: selected.routes,
    translationPolicy: selected.translationPolicy,
    helperModel: { id: f.helperModel.id },
    contextModel: null,
  });
  const writeArgs = { kind: 'content', id: f.saved.id, expectedRevision: 1 };
  const log = script(f, (request, index) => {
    expect(request.role).toBe('helper');
    expect(request.input.history).toEqual(recent);
    if (index === 0) {
      const encoded = encodeAnthropic(request);
      return decodeAnthropicMessage(
        {
          id: 'synthetic-long-write',
          type: 'message',
          role: 'assistant',
          model: request.modelId,
          stop_reason: 'tool_use',
          usage: { input_tokens: 11, output_tokens: 7200 },
          content: [
            { type: 'text', text: 'Plan and verify the proposed correction. '.repeat(900) },
            {
              type: 'tool_use',
              id: 'write-once',
              name: encoded.context.toolNames.find((item) => item.name === 'app.call')!.wireName,
              input: { name: 'resource.save', arguments: writeArgs },
            },
          ],
        },
        encoded.context
      );
    }
    expect(request).not.toHaveProperty('opaqueState');
    expect(events(request)).toEqual([]);
    expect(carried(request)).toEqual([
      {
        callId: 'write-once',
        name: 'app.call',
        args: { name: 'resource.save', arguments: writeArgs },
        result: { status: 'saved', id: f.saved.id, revision: 2, payload: '' },
        denied: false,
      },
    ]);
    expect(continuation(request)).toMatchObject({ segment: 1, completedReads: [] });
    return structuredClone(success);
  });
  const task = await f.run();
  expect(task, task.error ?? '').toMatchObject({ status: 'completed', usage: { modelCalls: 2 } });
  expect(log.requests).toHaveLength(2);
  const decisions = compactions(f, task);
  expect(decisions).toHaveLength(1);
  const [decision] = decisions;
  expect(decision.applied).toBe(true);
  expect(decision.beforeTokens).toBeGreaterThan(8192);
  expect(decision.afterTokens).toBeLessThanOrEqual(8192);
  expect(checkpointRows(f)).toEqual([]);
  expect(f.mutations).toBe(1);
  expect(f.store.product.get<Content>('content', f.saved.id).revision).toBe(2);
});

test.each([false, true])(
  'helper compaction preserves a bounded exact recent suffix and reloads it (oversized recent turn: %s)',
  async (oversizedRecent) => {
    const f = await fixture({ fixed: false, reviewOnly: true });
    f.updateModel(f.helperModel.id, { inputTokenLimit: 65536, tokenizer: 'openai-cl100k' });
    f.updateModel(f.contextModel.id, { tokenizer: 'openai-o200k' });
    const oldRequest = '먼저 이전 초안의 배경을 검토해 줘.';
    const oldReply = 'Earlier scene evidence and resolved background details. '.repeat(1800);
    const constraints = ['이름은 바꾸지 마. 🌱', '이번에는 제안만 해줘. 저장하지 마.'];
    let seed = true;
    const log = script(f, (request) => {
      expect(request.contextBudget).toMatchObject({
        estimator: 'model-local-v1',
        tokenizer: request.role === 'context' ? 'openai-o200k' : 'openai-cl100k',
      });
      if (seed)
        return summarized(
          request.input.task === oldRequest ||
            (oversizedRecent && request.input.task === constraints[1])
            ? oldReply
            : '그 조건을 유지할게요.'
        );
      if (request.role === 'context') {
        const part = String((request.input.source as { part: string }).part);
        expect(part).toContain(oldRequest);
        expect(part).toContain(oldReply);
        for (const constraint of constraints)
          if (oversizedRecent) expect(part).toContain(constraint);
          else expect(part).not.toContain(constraint);
        return summarized('Earlier background reviewed; its proposed edits were not saved.');
      }
      expect(request.input.task).toBe(f.request);
      expect(request.input.history).toEqual(oversizedRecent ? [] : recentMessages);
      return structuredClone(success);
    });
    for (const request of [oldRequest, ...constraints]) {
      const task = f.runtime.enqueue(f.conversation.id, randomUUID(), request);
      await Promise.all(f.work);
      expect(f.workspace.task(task.id).status).toBe('completed');
    }
    const messages = f.workspace.messages(f.conversation.id);
    const recentMessages = messages.slice(2).map(({ id, role, text }) => ({ id, role, text }));
    seed = false;
    log.requests.length = 0;
    f.updateModel(f.helperModel.id, { inputTokenLimit: 8192, tokenizer: 'openai-cl100k' });
    const task = await f.run();
    expect(task, task.error ?? '').toMatchObject({ status: 'completed', error: null });
    expect(log.requests.map((request) => request.role)).toEqual(['context', 'helper']);
    expect(
      f.workspace
        .events(f.conversation.id)
        .findLast((event) => event.taskId === task.id && event.kind === 'input.measured')?.data
    ).toMatchObject({ estimator: 'model-local-v1', tokenizer: 'openai-cl100k' });
    const checkpoint = JSON.parse(String(checkpointRows(f)[0].plan));
    expect(checkpoint.compacted.map((ref: { revision: string }) => ref.revision)).toEqual(
      (oversizedRecent ? messages : messages.slice(0, 2)).map((message) => message.id)
    );
    const currentMessage = f.workspace
      .messages(f.conversation.id)
      .find((message) => message.taskId === task.id && message.role === 'user')!;
    expect(checkpoint.recentSourceRevisions).toEqual([
      ...(oversizedRecent ? [] : recentMessages.map((message) => message.id)),
      currentMessage.id,
    ]);
    log.spy.mockRestore();
    const resumed = script(f, (request) => {
      expect(request.role).toBe('helper');
      expect(request.input.task).toBe('이제 남은 제안을 설명해 줘.');
      expect(request.input.history).toEqual(
        f.workspace
          .messages(f.conversation.id)
          .filter((message) => message.taskId !== next.id)
          .slice(oversizedRecent ? messages.length : 2)
          .map(({ id, role, text }) => ({ id, role, text }))
      );
      expect(request.input.source).toMatchObject({
        summary: { text: 'Earlier background reviewed; its proposed edits were not saved.' },
      });
      return structuredClone(success);
    });
    const next = f.runtime.enqueue(f.conversation.id, randomUUID(), '이제 남은 제안을 설명해 줘.');
    await Promise.all(f.work);
    expect(f.workspace.task(next.id).status).toBe('completed');
    expect(resumed.requests).toHaveLength(1);
    expect(f.mutations).toBe(0);
  }
);

test('helper compaction resumes completed library reads and exact writes within the same task', async () => {
  const f = await fixture({ fixed: false });
  f.updateModel(f.helperModel.id, { inputTokenLimit: 8192 });
  const librarySource = Array.from({ length: 3_000 }, (_, index) =>
    index.toString(36).padStart(4, '0')
  ).join(' ');
  const library = f.store.product.content(
    fixtureBotInput('Read progress register', librarySource)
  ) as Content;
  let helperCalls = 0;
  let originalSnapshot: HelperTask['snapshot'] | undefined;
  const log = script(f, (request) => {
    if (request.role === 'context') {
      expect(request.input.task).not.toBe(f.request);
      expect(request.input.source).toMatchObject({ originalRequest: f.request });
      expect(request.stable.contract).not.toContain(CONTEXT_CONTINUATION_GUIDANCE);
      return summarized(
        'The relevant evidence was checked. Next: save the draft and read the library.'
      );
    }
    if (++helperCalls === 1) {
      originalSnapshot = structuredClone(f.workspace.task(f.currentTaskId).snapshot);
      expect(continuation(request)).toBeUndefined();
      return tools(
        tool('saved', 'resource.save', { expectedRevision: 1 }),
        tool('found', 'app.call', {
          name: 'data.search',
          arguments: { scope: 'library', query: library.title, patterns: ['0000'] },
        })
      );
    }
    if (helperCalls === 2) {
      const found = events(request).find((event) => event.callId === 'found')!.result as any;
      expect(found.items).toHaveLength(1);
      return tools(
        tool('read', 'app.call', {
          name: 'data.read',
          arguments: { refs: [found.items[0].ref], limit: 10_000 },
        })
      );
    }
    expect(request.stable.contract).toContain(CONTEXT_CONTINUATION_GUIDANCE);
    expect(request.stable.contract).toContain(CONTEXT_RETRIEVAL_GUIDANCE);
    expect(continuation(request)).toMatchObject({
      kind: 'helper-task-continuation',
      taskId: f.currentTaskId,
      conversationId: f.conversation.id,
      segment: 1,
      status: 'in-progress',
      reason: 'host-compaction',
      completedReads: [
        {
          name: 'app.call',
          args: {
            name: 'data.search',
            arguments: { scope: 'library', query: library.title, patterns: ['0000'] },
          },
          returned: { items: [{ ref: { id: library.id, revision: 1 }, title: library.title }] },
        },
        {
          name: 'app.call',
          args: { name: 'data.read' },
          returned: { items: [{ ref: { id: library.id, revision: 1 } }] },
        },
      ],
    });
    expect(carried(request)).toMatchObject([
      {
        callId: 'saved',
        name: 'resource.save',
        denied: false,
        result: { id: f.saved.id, revision: 2 },
      },
    ]);
    expect(JSON.stringify(request.input)).not.toContain(librarySource);
    expect(events(request)).toEqual([]);
    expect(request).not.toHaveProperty('opaqueState');
    expect(f.workspace.task(f.currentTaskId).snapshot).toEqual(originalSnapshot);
    const savedReceipt = f.store.db
      .prepare('SELECT result FROM helper_operations WHERE task_id=?')
      .get(f.currentTaskId)!;
    expect(carried(request)[0].result).toEqual(JSON.parse(String(savedReceipt.result)));
    return structuredClone(success);
  });
  const task = await f.run();
  if (task.status !== 'completed') throw new Error(task.error ?? 'helper failed');
  expect(task.status).toBe('completed');
  expect(task.snapshot.scope).toEqual(originalSnapshot!.scope);
  expect(task.snapshot.history).toEqual([]);
  expect(task.snapshot).not.toHaveProperty('editor');
  expect(task.snapshot).not.toHaveProperty('contextModel');
  expect(task.usage.modelCalls).toBe(4);
  expect(log.requests.map((request) => request.role)).toEqual([
    'helper',
    'helper',
    'context',
    'helper',
  ]);
  const limit = f.target('helper').inputTokenLimit!;
  expect(
    estimateContextTokens(encodeMainPreview(log.requests[1], f.target('helper')).body)
  ).toBeLessThan(limit * 0.85);
  expect(f.mutations).toBe(1);
  expect(compactions(f, task)).toHaveLength(1);
  expect(compactions(f, task)[0].applied).toBe(true);
  expect(compactions(f, task)[0].beforeTokens).toBeGreaterThan(limit);
  expect(compactions(f, task)[0].afterTokens).toBeLessThan(limit);
  const resumed = log.requests.at(-1)!;
  const receipt = f.store.db
    .prepare('SELECT result FROM helper_operations WHERE task_id=?')
    .get(task.id)!;
  expect(JSON.parse(String(receipt.result))).toEqual({ detailsOmitted: true });
  const fixedRequest = structuredClone(resumed);
  const source = fixedRequest.input.source as Record<string, transport.Json>;
  (source.summary as Record<string, transport.Json>).text = '';
  const fixedTokens = estimateContextTokens(
    encodeMainPreview(fixedRequest, f.target('helper')).body
  );
  expect(
    log.requests.find((request) => request.role === 'context')!.input.controls.targetSummaryTokens
  ).toBe(Math.max(1, Math.floor(Math.min(2048, limit / 8, limit - fixedTokens))));
});

test('completed read references retain returned ranges and revisions while allowing a needed reread', async () => {
  const f = await fixture();
  f.readValue = {
    id: 'draft-evidence',
    revision: 1,
    hash: 'draft-hash-one',
    text: readText,
    source: {
      revision: 'source-one',
      hash: 'source-hash-one',
      start: 10,
      end: 60,
      text: 'RAW_SOURCE_CANARY',
    },
    range: { start: 10, end: 60, unit: 'utf16-code-unit' },
    keptRanges: [
      { start: 10, end: 25 },
      { start: 40, end: 60 },
    ],
    excludedRanges: [{ start: 25, end: 40 }],
    rangeSemantics: 'source coordinates; text concatenates keptRanges',
    totalChars: 500,
    truncated: true,
    nextOffset: 60,
    version: 'outline-view-one',
    scope: { chatId: 'story', mode: 'detail', nodeId: 'unit', section: 'intent' },
    coverage: { content: 'intent-range', wholeField: false, returned: 1 },
    committedEffects: {
      total: 1,
      offset: 0,
      nextOffset: null,
      items: [
        {
          receiptId: 'durable-save',
          committed: true,
          tool: 'outline.write',
          callId: 'save-one',
          createdAt: '2026-09-29T03:00:00Z',
        },
      ],
    },
    nextRead: {
      name: 'app.call',
      arguments: {
        name: 'outline.read',
        arguments: {
          nodeId: 'unit',
          mode: 'detail',
          offset: 60,
          expectedVersion: 'outline-view-one',
        },
      },
    },
  };
  let helperCalls = 0;
  const log = script(f, (request) => {
    if (request.role === 'context') return summarized();
    if (++helperCalls === 1)
      return tools(tool('read-one', 'resource.read', { kind: 'content', id: 'read-evidence' }));
    if (helperCalls === 2) {
      expect(continuation(request)?.completedReads).toHaveLength(1);
      return tools(tool('quote-reread', 'resource.read', { kind: 'content', id: 'read-evidence' }));
    }
    if (helperCalls === 3) {
      expect(events(request).at(-1)).toMatchObject({ callId: 'quote-reread', denied: false });
      f.readValue = {
        ...f.readValue,
        revision: 2,
        hash: 'draft-hash-two',
        text: 'Exact changed source segment.',
        source: { revision: 'source-two', hash: 'source-hash-two', start: 60, end: 110 },
        range: { start: 60, end: 110, unit: 'utf16-code-unit' },
        keptRanges: [{ start: 60, end: 110 }],
        excludedRanges: [],
        nextOffset: 110,
      };
      return tools(
        tool('changed-source', 'resource.read', {
          kind: 'content',
          id: 'read-evidence',
          path: '/package/nativeRisu/card/description',
          textOffset: 60,
        })
      );
    }
    const resumed = continuation(request)!;
    expect(resumed.segment).toBe(2);
    expect(resumed.completedReads).toHaveLength(2);
    expect(resumed.completedReads[0]).toEqual({
      name: 'resource.read',
      args: { kind: 'content', id: 'read-evidence' },
      returned: {
        id: 'draft-evidence',
        revision: 1,
        hash: 'draft-hash-one',
        source: { revision: 'source-one', hash: 'source-hash-one', start: 10, end: 60 },
        range: { start: 10, end: 60, unit: 'utf16-code-unit' },
        keptRanges: [
          { start: 10, end: 25 },
          { start: 40, end: 60 },
        ],
        excludedRanges: [{ start: 25, end: 40 }],
        rangeSemantics: 'source coordinates; text concatenates keptRanges',
        totalChars: 500,
        truncated: true,
        nextOffset: 60,
        version: 'outline-view-one',
        scope: { chatId: 'story', mode: 'detail', nodeId: 'unit', section: 'intent' },
        coverage: { content: 'intent-range', wholeField: false, returned: 1 },
        committedEffects: {
          total: 1,
          offset: 0,
          nextOffset: null,
          items: [
            {
              receiptId: 'durable-save',
              committed: true,
              tool: 'outline.write',
              callId: 'save-one',
              createdAt: '2026-09-29T03:00:00Z',
            },
          ],
        },
        nextRead: {
          name: 'app.call',
          arguments: {
            name: 'outline.read',
            arguments: {
              nodeId: 'unit',
              mode: 'detail',
              offset: 60,
              expectedVersion: 'outline-view-one',
            },
          },
        },
      },
    });
    expect(resumed.completedReads[1].returned).toMatchObject({
      revision: 2,
      hash: 'draft-hash-two',
      source: { revision: 'source-two', hash: 'source-hash-two', start: 60, end: 110 },
      range: { start: 60, end: 110, unit: 'utf16-code-unit' },
      nextOffset: 110,
    });
    expect(JSON.stringify(resumed)).not.toContain('RAW_SOURCE_CANARY');
    expect(JSON.stringify(resumed)).not.toContain(readText);
    return structuredClone(success);
  });
  const task = await f.run();
  expect(task).toMatchObject({ status: 'completed', error: null });
  expect(log.requests.map((request) => request.role)).toEqual([
    'helper',
    'context',
    'helper',
    'helper',
    'context',
    'helper',
  ]);
  expect(compactions(f, task).map((decision) => decision.applied)).toEqual([true, true]);
  expect(task.snapshot.context).toEqual({ activeRevision: 0, checkpoint: null });
});

test.each([
  ['resource.readMany', false],
  ['resource.read', true],
] as const)(
  'forced compaction retains exact small %s evidence and app schemas (query: %s)',
  async (readName, querySchema) => {
    const f = await fixture();
    const compactionSource = Array.from({ length: 1_400 }, (_, index) =>
      index.toString(36).padStart(4, '0')
    ).join(' ');
    const library = f.store.product.content(
      fixtureBotInput('Read material', compactionSource)
    ) as Content;
    const exactSource = 'Exact small source name 🌱';
    const selection = {
      kind: 'content',
      id: f.saved.id,
      path: '/package/nativeRisu/card/name',
    };
    const exactField = {
      kind: 'content',
      id: f.saved.id,
      revision: 1,
      path: '/package/nativeRisu/card/name',
      exists: true,
      type: 'string',
      length: exactSource.length,
      text: exactSource,
      textOffset: 0,
      nextOffset: null,
    };
    f.readValue =
      readName === 'resource.readMany'
        ? { items: [{ requestIndex: 0, result: exactField }], nextIndex: null }
        : exactField;
    let helperCalls = 0;
    const log = script(f, (request) => {
      if (request.role === 'context') {
        const summaryInput = String((request.input.source as { part: string }).part);
        expect(summaryInput).toContain('schemasRetained');
        expect(summaryInput).not.toContain('inputSchema');
        expect(summaryInput).toContain(exactSource);
        return summarized();
      }
      if (++helperCalls === 1)
        return tools(
          tool('material', 'data.search', {
            scope: 'library',
            ids: [library.id],
            patterns: ['0'],
            context: 1200,
            limit: 50,
          }),
          tool(
            'schema',
            'app.tools',
            querySchema ? { query: 'scene.versions' } : { names: [readName, 'resource.patch'] }
          ),
          tool(
            'field',
            readName,
            readName === 'resource.readMany' ? { items: [selection] } : selection
          )
        );
      const refs = continuation(request)?.completedReads ?? [];
      expect(JSON.stringify(request.input)).not.toContain(compactionSource);
      expect(refs).toContainEqual(
        expect.objectContaining({
          name: readName,
          returned: f.readValue,
        })
      );
      const schema = refs.find((item) => item.name === 'app.tools')?.returned as {
        tools: { name: string; inputSchema: unknown }[];
      };
      if (querySchema) expect(schema.tools[0].name).toBe('scene.versions');
      else expect(schema.tools.map((item) => item.name)).toEqual([readName, 'resource.patch']);
      expect(schema.tools.every((item) => !!item.inputSchema)).toBe(true);
      expect(JSON.stringify(schema).length).toBeLessThan(8_000);
      return structuredClone(success);
    });
    const task = await f.run();
    if (task.status !== 'completed') throw new Error(task.error ?? 'helper failed');
    expect(task.status, task.error ?? '').toBe('completed');
    expect(log.requests[0].role).toBe('helper');
    expect(log.requests.at(-1)?.role).toBe('helper');
    expect(log.requests.some((request) => request.role === 'context')).toBe(true);
    expect(compactions(f, task).map((decision) => decision.applied)).toEqual([true]);
  }
);

test('forced compaction retains large batch identities and continuation without body text', async () => {
  const f = await fixture();
  const current = {
    kind: 'content',
    id: f.saved.id,
    revision: 1,
    path: '/package/nativeRisu/card/description',
    exists: true,
    type: 'string',
    length: 20_000,
    textOffset: 120,
    nextOffset: 9_120,
  };
  const previous = {
    kind: 'prompt-preset',
    id: 'previous-preset',
    revision: null,
    version: 'previous',
    currentRevision: 7,
    path: '/program/nativeRisuPreset/preset/promptTemplate/0/text',
    exists: true,
    type: 'string',
    length: 200,
    textOffset: 10,
    nextOffset: 30,
  };
  const array = {
    kind: 'prompt-preset',
    id: 'current-preset',
    revision: 3,
    path: '/program/nativeRisuPreset/preset/promptTemplate',
    exists: true,
    type: 'array',
    total: 2,
    offset: 0,
    nextOffset: 1,
    items: [
      {
        path: '/program/nativeRisuPreset/preset/promptTemplate/0',
        target: '/program/nativeRisuPreset/preset/promptTemplate/0',
        exists: true,
        type: 'object',
        block: {
          omittedBodyPaths: {
            text: '/program/nativeRisuPreset/preset/promptTemplate/0/text',
            innerFormat: '/program/nativeRisuPreset/preset/promptTemplate/0/innerFormat',
          },
        },
      },
    ],
  };
  const missing = { requestIndex: 3, error: '자료를 찾을 수 없어요.', status: 404 };
  const body = 'LARGE_BATCH_BODY_CANARY '.repeat(400).slice(0, 9_000);
  f.readValue = {
    items: [
      { requestIndex: 0, result: { ...current, text: body } },
      { requestIndex: 1, result: { ...previous, text: 'PREVIOUS_BODY_CANARY' } },
      { requestIndex: 2, result: array },
      missing,
    ],
    nextIndex: null,
  };
  expect(countTextTokens(JSON.stringify(f.readValue))).toBeGreaterThan(2_000);
  let helperCalls = 0;
  const log = script(f, (request) => {
    if (request.role === 'context') return summarized();
    if (++helperCalls === 1)
      return tools(
        tool('batch', 'resource.readMany', {
          items: [
            { kind: current.kind, id: current.id, path: current.path, textOffset: 120 },
            { kind: previous.kind, id: previous.id, path: previous.path, version: 'previous' },
            { kind: array.kind, id: array.id, path: array.path, limit: 1, includeBodies: true },
            { kind: 'content', id: 'missing-resource' },
          ],
        })
      );
    const retained = continuation(request)?.completedReads;
    expect(retained).toEqual([
      expect.objectContaining({
        name: 'resource.readMany',
        returned: {
          items: [
            { requestIndex: 0, result: current },
            { requestIndex: 1, result: previous },
            { requestIndex: 2, result: array },
            missing,
          ],
          nextIndex: null,
        },
      }),
    ]);
    expect(JSON.stringify(retained)).not.toContain('LARGE_BATCH_BODY_CANARY');
    expect(JSON.stringify(retained)).not.toContain('PREVIOUS_BODY_CANARY');
    return structuredClone(success);
  });
  const task = await f.run();
  expect(task).toMatchObject({ status: 'completed', error: null });
  expect(log.requests[0].role).toBe('helper');
  expect(log.requests.at(-1)?.role).toBe('helper');
  expect(log.requests.some((request) => request.role === 'context')).toBe(true);
  expect(compactions(f, task).map((decision) => decision.applied)).toEqual([true]);
});

test('small helper compaction stays above 85%, preserves exact writes, and waits for new read data', async () => {
  const f = await fixture();
  let helperCalls = 0;
  const log = script(f, (request) => {
    if (request.role === 'context') {
      expect(request.stable.tools).toEqual([]);
      expect(Number(request.input.controls?.targetSummaryTokens)).toBeGreaterThan(1);
      expect(request.generation?.maxOutputTokens).toBe(8192);
      expect(Number(request.input.controls?.targetSummaryTokens)).toBeLessThanOrEqual(4096);
      if (helperCalls === 1)
        expect(Number(request.input.controls?.targetSummaryTokens)).toBeGreaterThan(2048);
      expect(f.workspace.task(f.currentTaskId).snapshot.contextModel?.maxOutputTokens).toBe(8192);
      return summarized();
    }
    helperCalls++;
    if (helperCalls === 1)
      return tools(tool('read-one', 'resource.read', { kind: 'content', id: 'read-evidence' }));
    if (helperCalls === 2) {
      expect(events(request)).toEqual([]);
      expect(request).not.toHaveProperty('opaqueState');
      return tools(tool('write-once', 'resource.save', { expectedRevision: 1 }));
    }
    if (helperCalls === 3)
      return tools(
        tool('same-data-new-call-id', 'resource.read', { kind: 'content', id: 'read-evidence' })
      );
    if (helperCalls === 4) {
      f.readValue = { revision: 2, text: readText + ' A newly verified condition.' };
      return tools(tool('new-data', 'resource.read', { kind: 'content', id: 'read-evidence' }));
    }
    expect(carried(request)).toEqual([
      expect.objectContaining({
        callId: 'write-once',
        name: 'resource.save',
        args: { expectedRevision: 1 },
        result: {
          status: 'saved',
          id: f.saved.id,
          revision: 2,
          payload: '',
        },
        denied: false,
      }),
    ]);
    if (helperCalls === 5)
      return tools(
        tool('stale-save', 'resource.save', {
          expectedRevision: 1,
        })
      );
    expect(events(request).at(-1)).toMatchObject({
      denied: true,
      errorKind: 'recoverable',
      result: { error: expect.any(String) },
    });
    return structuredClone(success);
  });
  const task = await f.run();
  expect(task).toMatchObject({ status: 'completed', usage: { modelCalls: 8, costUsd: null } });
  expect(log.requests.map((request) => request.role)).toEqual([
    'helper',
    'context',
    'helper',
    'helper',
    'helper',
    'context',
    'helper',
    'helper',
  ]);
  const decisions = compactions(f, task),
    limit = f.target('helper').inputTokenLimit!;
  expect(decisions).toHaveLength(2);
  expect(decisions[0]).toMatchObject({ applied: true });
  expect(decisions[0].afterTokens).toBeGreaterThan(limit * 0.85);
  expect(decisions[0].afterTokens).toBeGreaterThanOrEqual(decisions[0].beforeTokens * 0.9);
  expect(decisions[0].afterTokens).toBeLessThan(decisions[0].beforeTokens);
  expect(decisions[0].afterTokens).toBeLessThanOrEqual(limit);
  expect(f.mutations).toBe(1);
  expect(f.store.product.get<Content>('content', f.saved.id).revision).toBe(2);
  expect(checkpointRows(f)).toHaveLength(1);
  expect(task.snapshot.model.maxOutputTokens).toBe(1024);
  expect(task.snapshot).not.toHaveProperty('contextModel');
});

test('unhelpful helper compaction preserves actual Vertex signatures, results and write-only continuation', async () => {
  const f = await fixture({ vertex: true });
  const nativeBodies: any[] = [],
    roles: string[] = [];
  const sse = eventStream,
    reply = vertexReply;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) => {
      const body = JSON.parse(String(options?.body));
      if (String(url).startsWith(origin)) {
        roles.push('context');
        return sse(
          { type: 'text_delta', delta: expandedSummary },
          { type: 'usage', inputTokens: 11, outputTokens: 7, costUsd: null },
          { type: 'done', reason: 'stop' }
        );
      }
      expect(String(url)).toMatch(/^https:\/\/aiplatform\.googleapis\.com\//u);
      roles.push('helper');
      nativeBodies.push(body);
      if (nativeBodies.length === 1)
        return reply([
          {
            functionCall: {
              id: 'first-read',
              name: 'app.call',
              args: { name: 'resource.read', arguments: { kind: 'content', id: 'read-evidence' } },
            },
            thoughtSignature: 'READ_SIGNATURE',
          },
        ]);
      if (nativeBodies.length === 2)
        return reply([
          {
            functionCall: {
              id: 'write',
              name: 'app.call',
              args: { name: 'resource.save', arguments: { expectedRevision: 1 } },
            },
            thoughtSignature: 'WRITE_SIGNATURE',
          },
        ]);
      if (nativeBodies.length === 3) {
        f.readValue = { revision: 2, text: readText + ' Changed source revision.' };
        return reply([
          {
            functionCall: {
              id: 'new-read',
              name: 'app.call',
              args: { name: 'resource.read', arguments: { kind: 'content', id: 'read-evidence' } },
            },
            thoughtSignature: 'NEW_READ_SIGNATURE',
          },
        ]);
      }
      return reply([{ text: success.text }]);
    })
  );
  const task = await f.run();
  expect(task).toMatchObject({ status: 'completed', usage: { modelCalls: 6, costUsd: null } });
  expect(roles).toEqual(['helper', 'context', 'helper', 'helper', 'context', 'helper']);
  const responses = (body: any) =>
    body.contents
      .flatMap((entry: any) => entry.parts)
      .flatMap((part: any) => (part.functionResponse ? [part.functionResponse] : []));
  const firstRead = responses(nativeBodies[1]).find((part: any) => part.id === 'first-read');
  expect(firstRead.response).toEqual({ revision: 1, text: readText });
  for (const body of nativeBodies.slice(1)) {
    expect(JSON.stringify(body)).toContain('READ_SIGNATURE');
    expect(JSON.stringify(body)).not.toContain('host-completed-tool-history');
    expect(JSON.stringify(body)).not.toContain('helper-task-continuation');
    expect(responses(body).find((part: any) => part.id === 'first-read')).toEqual(firstRead);
    expect(estimateContextTokens(body)).toBeLessThanOrEqual(f.target('helper').inputTokenLimit!);
  }
  expect(JSON.stringify(nativeBodies[2])).toContain('WRITE_SIGNATURE');
  expect(JSON.stringify(nativeBodies[3])).toContain('NEW_READ_SIGNATURE');
  expect(compactions(f, task).map((decision) => decision.applied)).toEqual([false, false]);
  expect(checkpointRows(f)).toEqual([]);
  expect(f.mutations).toBe(1);
});

test('a Vertex signature far larger than the input limit neither compacts the task nor fails admission', async () => {
  const f = await fixture({ vertex: true });
  const limit = f.target('helper').inputTokenLimit! * 2;
  f.updateModel(f.helperModel.id, { inputTokenLimit: limit });
  f.readValue = { revision: 1, text: 'Short evidence.' };
  const signature = randomBytes(limit * 12).toString('base64');
  expect(countTextTokens(signature)).toBeGreaterThan(limit);
  const bodies: any[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) => {
      expect(String(url)).toMatch(/^https:\/\/aiplatform\.googleapis\.com\//u);
      bodies.push(JSON.parse(String(options?.body)));
      return bodies.length === 1
        ? vertexReply([
            {
              functionCall: {
                id: 'signed-read',
                name: 'app.call',
                args: {
                  name: 'resource.read',
                  arguments: { kind: 'content', id: 'read-evidence' },
                },
              },
              thoughtSignature: signature,
            },
          ])
        : vertexReply([{ text: success.text }]);
    })
  );
  const task = await f.run();
  expect(task).toMatchObject({ status: 'completed', usage: { modelCalls: 2 } });
  expect(JSON.stringify(bodies[1])).toContain(signature);
  expect(compactions(f, task)).toEqual([]);
});

test('a resumed task summarizes the reads it carried once they no longer fit', async () => {
  const f = await fixture();
  const fitted = f.target('helper').inputTokenLimit!;
  f.updateModel(f.helperModel.id, { inputTokenLimit: fitted * 4 });
  let helperCalls = 0;
  const log = script(f, (request) => {
    if (request.role === 'context') return summarized();
    if (++helperCalls === 1)
      return tools(
        tool('read', 'resource.read', { kind: 'content', id: 'read-evidence' }),
        tool('save', 'resource.save', { expectedRevision: 1 })
      );
    if (helperCalls === 2)
      return {
        ...structuredClone(success),
        status: 'error',
        text: '',
        error: { code: 'HTTP_400' },
      };
    return structuredClone(success);
  });
  const stopped = await f.run();
  expect(stopped).toMatchObject({
    status: 'failed',
    resumable: true,
    completedEffects: { count: 1 },
  });
  expect(compactions(f, stopped)).toEqual([]);

  f.updateModel(f.helperModel.id, { inputTokenLimit: fitted });
  const resumed = f.runtime.enqueue(
    f.conversation.id,
    randomUUID(),
    f.request,
    undefined,
    undefined,
    stopped.id,
    undefined,
    true,
    undefined,
    { resume: true }
  );
  await Promise.all(f.work);
  const finished = f.runtime.workspace.task(resumed.id);
  expect(finished, finished.error ?? '').toMatchObject({ status: 'completed' });
  expect(log.requests.map((request) => request.role)).toEqual([
    'helper',
    'helper',
    'context',
    'helper',
  ]);
  expect(compactions(f, finished)).toMatchObject([{ applied: true }]);
  const source = log.requests.at(-1)!.input.source as unknown as {
    continuation: { reason: string; completedReads: { name: string }[] };
    completedToolHistory: { events: ToolEvent[] };
  };
  expect(source.continuation).toMatchObject({
    reason: 'host-compaction',
    completedReads: [{ name: 'resource.read' }],
  });
  expect(source.completedToolHistory.events.map((event) => event.callId)).toEqual(['save']);
  expect(f.mutations).toBe(1);
});

test('an oversized fixed receipt fails before another summary without losing the committed effect', async () => {
  const f = await fixture();
  let helperCalls = 0,
    summaryCalls = 0;
  const log = script(f, (request) => {
    if (request.role === 'context')
      return summarized(++summaryCalls === 1 ? expandedSummary : summaryText);
    if (++helperCalls === 1)
      return tools(tool('read', 'resource.read', { kind: 'content', id: 'read-evidence' }));
    f.receiptPadding = 'Exact retained mutation receipt. '.repeat(4000);
    return tools(
      tool('saved-before-hard-crossing', 'resource.save', {
        expectedRevision: 1,
      })
    );
  });
  const task = await f.run();
  expect(task).toMatchObject({
    status: 'failed',
    error: 'HELPER_FIXED_CONTEXT_TOO_LARGE',
    usage: { modelCalls: 3 },
    completedEffects: { count: 1 },
  });
  expect(log.requests[0].role).toBe('helper');
  expect(log.requests.at(-1)?.role).toBe('helper');
  expect(log.requests.some((request) => request.role === 'context')).toBe(true);
  const decisions = compactions(f, task),
    limit = f.target('helper').inputTokenLimit!;
  expect(decisions).toHaveLength(1);
  expect(decisions[0].beforeTokens).toBeLessThanOrEqual(limit);
  expect(checkpointRows(f)).toEqual([]);
  expect(f.mutations).toBe(1);
  const receipt = f.store.db
    .prepare('SELECT result FROM helper_operations WHERE task_id=?')
    .get(task.id)!;
  expect(JSON.parse(String(receipt.result)).payload).toBe(f.receiptPadding);
});

test('a reused call ID cannot execute again after the helper segment is compacted', async () => {
  const f = await fixture();
  let helperCalls = 0;
  script(f, (request) => {
    if (request.role === 'context') return summarized();
    if (++helperCalls === 1)
      return tools(tool('read-id', 'resource.read', { kind: 'content', id: 'read-evidence' }));
    return tools(tool('read-id', 'resource.save', { expectedRevision: 1 }));
  });
  const task = await f.run();
  expect(task).toMatchObject({
    status: 'failed',
    error: 'DUPLICATE_TOOL_ID',
    usage: { modelCalls: 3 },
  });
  expect(f.mutations).toBe(0);
  expect(checkpointRows(f)).toHaveLength(1);
});

test.each(['eof', 'cancelled'] as const)(
  'saved effects survive helper compaction %s without automatic replay',
  async (outcome) => {
    const f = await fixture();
    let helperCalls = 0;
    const log = script(f, (request) => {
      if (request.role === 'context') {
        if (outcome === 'eof')
          return {
            ...structuredClone(success),
            status: 'error',
            text: 'Partial summary',
            error: { code: 'UNEXPECTED_EOF' },
          };
        if (outcome === 'cancelled') f.runtime.cancel(f.currentTaskId);
        return summarized();
      }
      if (++helperCalls === 1) return tools(tool('save', 'resource.save', { expectedRevision: 1 }));
      return tools(tool('read', 'resource.read', { kind: 'content', id: 'read-evidence' }));
    });
    const task = await f.run();
    expect(task.status).toBe(outcome === 'cancelled' ? 'cancelled' : 'failed');
    if (outcome === 'eof') expect(task.error).toBe('HELPER_COMPACTION_EOF');
    expect(task.usage.modelCalls).toBe(3);
    expect(task.completedEffects?.count).toBe(1);
    expect(log.requests.map((request) => request.role)).toEqual(['helper', 'helper', 'context']);
    expect(f.mutations).toBe(1);
    expect(f.store.product.get<Content>('content', f.saved.id).revision).toBe(2);
    expect(() =>
      f.runtime.enqueue(f.conversation.id, randomUUID(), f.request, f.editor, undefined, task.id)
    ).toThrow('HELPER_EFFECTS_ALREADY_COMMITTED');
    expect(checkpointRows(f)).toEqual([]);
  }
);

test.each(['current failed task', 'earlier completed task'] as const)(
  'a read-only retry invalidates only a checkpoint covering its replaced messages (%s)',
  async (coveredTask) => {
    const f = await fixture({ fixed: false, reviewOnly: true });
    const constraint = '이름은 바꾸지 말고 제안만 해줘. 저장하지 마.';
    const seed = script(f, () => structuredClone(success));
    const earlier = f.runtime.enqueue(f.conversation.id, randomUUID(), constraint);
    await Promise.all(f.work);
    expect(f.workspace.task(earlier.id).status).toBe('completed');
    seed.spy.mockRestore();
    f.readValue = {
      revision: 1,
      text: Array.from({ length: 1_600 }, (_, index) => index.toString(36).padStart(4, '0')).join(
        ' '
      ),
    };
    expect(estimateContextTokens(f.readValue)).toBeLessThan(f.target('helper').inputTokenLimit!);
    let helperCalls = 0;
    const failedCall = coveredTask === 'current failed task' ? 2 : 3;
    const log = script(f, (request) => {
      if (request.role === 'context') return summarized();
      if (++helperCalls === 1)
        return tools(tool('evidence', 'resource.read', { kind: 'content', id: f.saved.id }));
      if (helperCalls === failedCall)
        return {
          ...structuredClone(success),
          status: 'error',
          text: 'Unfinished review',
          error: { code: 'UNEXPECTED_EOF' },
        };
      return structuredClone(success);
    });
    let failed = await f.run();
    expect(checkpointRows(f)).toHaveLength(1);
    if (coveredTask === 'earlier completed task') {
      expect(failed.status).toBe('completed');
      const next = f.runtime.enqueue(f.conversation.id, randomUUID(), 'Explain the review.');
      await Promise.all(f.work);
      failed = f.workspace.task(next.id);
    }
    expect(failed).toMatchObject({ status: 'failed', error: 'UNEXPECTED_EOF' });
    expect(failed).not.toHaveProperty('completedEffects');
    const checkpoints = checkpointRows(f);
    const head = () =>
      f.store.db
        .prepare('SELECT revision,checkpoint_id FROM context_heads WHERE scope_key=?')
        .get(`helper:${f.conversation.id}`)!;
    const before = head();
    const priorMessages = f.workspace.messages(f.conversation.id);
    const retry = f.runtime.enqueue(
      f.conversation.id,
      randomUUID(),
      'Finish the review; do not save changes.',
      undefined,
      undefined,
      failed.id
    );
    expect(checkpointRows(f)).toEqual(checkpoints);
    await Promise.all(f.work);
    expect(f.workspace.task(retry.id), f.workspace.task(retry.id).error ?? '').toMatchObject({
      status: 'completed',
      usage: { modelCalls: 1, inputTokens: 11, outputTokens: 7 },
    });
    const retriedInput = log.requests.at(-1)!;
    expect(retriedInput.input.task).toBe('Finish the review; do not save changes.');
    expect(retriedInput.input.history).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'user', text: constraint })])
    );
    expect(retriedInput.input.source).toMatchObject({
      summary: {
        text: coveredTask === 'earlier completed task' ? summaryText : '',
      },
    });
    expect(JSON.stringify(retriedInput.input.history)).not.toContain('Unfinished review');
    expect(head()).toEqual(
      coveredTask === 'earlier completed task'
        ? before
        : { revision: Number(before.revision) + 1, checkpoint_id: null }
    );
    for (const message of priorMessages)
      expect(
        f.store.db.prepare('SELECT text FROM helper_messages WHERE id=?').get(message.id)
      ).toMatchObject({ text: message.text });
    const next = f.runtime.enqueue(f.conversation.id, randomUUID(), 'Continue reviewing only.');
    await Promise.all(f.work);
    expect(f.workspace.task(next.id).status).toBe('completed');
    expect(f.mutations).toBe(0);
    expect(f.store.product.get<Content>('content', f.saved.id).revision).toBe(1);
    expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations').get()).toEqual({
      n: 0,
    });
    expect(log.requests.filter((request) => request.role === 'context')).toHaveLength(1);
  }
);

test('an oversized captured editor is paged before its source reaches a provider', async () => {
  const f = await fixture({ fixed: false });
  const canary = 'OVERSIZED_PRIVATE_LIBRARY_BODY';
  const library = f.store.product.content(
    fixtureBotInput('Oversized source', canary.repeat(2_000))
  ) as Content;
  Object.assign(f.editor, {
    kind: 'content',
    targetId: library.id,
    revision: library.revision,
    title: library.title,
    model: editableResource('content', library),
    source: 'unsaved',
  });
  let helperCalls = 0;
  const log = script(f, (request) => {
    expect(request.role).toBe('helper');
    helperCalls++;
    if (helperCalls === 1) return tools(tool('editor-overview', 'editor.read', {}));
    if (helperCalls === 2) {
      expect(events(request)).toContainEqual(
        expect.objectContaining({
          callId: 'editor-overview',
          denied: false,
          result: expect.objectContaining({
            inputOrigin: 'unsaved-device-editor',
            id: library.id,
            revision: library.revision,
            regions: expect.any(Array),
          }),
        })
      );
      return tools(
        tool('editor-field', 'editor.read', {
          path: '/package/nativeRisu/card/description',
          textLimit: 80,
        })
      );
    }
    expect(events(request)).toContainEqual(
      expect.objectContaining({
        callId: 'editor-field',
        denied: false,
        result: expect.objectContaining({
          inputOrigin: 'unsaved-device-editor',
          text: expect.stringContaining(canary),
          nextOffset: 80,
        }),
      })
    );
    expect(JSON.stringify(request)).not.toContain(canary.repeat(2_000));
    return structuredClone(success);
  });
  const task = await f.run();
  if (task.status !== 'completed') throw new Error(task.error ?? 'helper failed');
  expect(task).toMatchObject({ status: 'completed', usage: { modelCalls: 3 } });
  expect(log.requests.map((request) => request.role)).toEqual(['helper', 'helper', 'helper']);
  expect(compactions(f, task)).toEqual([]);
  expect(checkpointRows(f)).toEqual([]);
  const finished = f.workspace
    .events(f.conversation.id)
    .find((event) => event.taskId === task.id && event.kind === 'tool.finished');
  expect(finished?.data).toMatchObject({
    name: 'editor.read',
    originalResultChars: expect.any(Number),
    providedResultChars: expect.any(Number),
  });
  expect((finished!.data as any).originalResultChars).toBeLessThan(24_000);
  expect((finished!.data as any).providedResultChars).toBeLessThan(24_000);
});

test('a concurrent helper checkpoint remains active when the current task adopts a late candidate', async () => {
  const f = await fixture();
  let replacementId = '',
    helperCalls = 0;
  script(f, (request) => {
    if (request.role === 'context') {
      const current = f.workspace.task(f.currentTaskId);
      const published = publishHelperContext(
        f.store,
        current,
        'Concurrent valid helper summary',
        { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
        100,
        current.snapshot.context!
      );
      replacementId = published.checkpoint.id;
      return summarized();
    }
    if (++helperCalls === 1)
      return tools(tool('read', 'resource.read', { kind: 'content', id: 'read-evidence' }));
    return structuredClone(success);
  });
  const task = await f.run();
  expect(task.status).toBe('completed');
  const rows = checkpointRows(f);
  expect(rows).toHaveLength(1);
  expect(rows.map((row) => Number(row.activated))).toEqual([1]);
  expect(
    f.store.db
      .prepare('SELECT checkpoint_id FROM context_heads WHERE scope_key=?')
      .get(`helper:${f.conversation.id}`)?.checkpoint_id
  ).toBe(replacementId);
  expect(task.snapshot.context).toEqual({ activeRevision: 0, checkpoint: null });
});

test('manual helper compaction publishes a manual checkpoint, records numeric-only summary usage, noops when repeated, and feeds the next turn', async () => {
  const f = await fixture({ fixed: false });
  const log = script(f, (request) => {
    if (request.role === 'context') return summarized('수동 압축 요약: 초안 핵심 규칙을 정리했다.');
    return structuredClone(success);
  });
  const empty = f.runtime.compactConversation(f.conversation.id);
  expect(empty).toMatchObject({ started: false, noopReason: 'empty', compactedMessages: 0 });
  expect(log.requests).toHaveLength(0);

  const first = await f.run();
  expect(first.status).toBe('completed');
  expect(readHelperContextState(f.store, f.conversation.id)).toMatchObject({
    compactedMessages: 0,
    uncompactedMessages: 2,
    totalMessages: 2,
    compaction: { running: null, last: null },
  });

  const { started, last } = await compactNow(f);
  expect(started).toMatchObject({ started: true });
  expect(last).toMatchObject({ status: 'completed', compactedMessages: 2 });
  if (last?.status !== 'completed') throw new Error('compaction did not complete');
  expect(last.beforeTokens).toBeGreaterThan(0);
  expect(last.afterTokens).toBeGreaterThan(0);
  expect(readHelperContextState(f.store, f.conversation.id)).toMatchObject({
    compactedMessages: 2,
    uncompactedMessages: 0,
    totalMessages: 2,
    checkpointRevision: 1,
  });

  const rows = checkpointRows(f);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ origin: 'manual', activated: 1 });

  const attempt = f.store.db
    .prepare(
      "SELECT usage_kind, usage_detached, status, request FROM attempts WHERE role='context' ORDER BY rowid DESC LIMIT 1"
    )
    .get() as Record<string, unknown>;
  expect(attempt).toMatchObject({ usage_kind: 'summary', usage_detached: 1, status: 'completed' });
  expect(String(attempt.request)).not.toContain('현재 초안을 수정하고 저장해줘.');

  const repeated = f.runtime.compactConversation(f.conversation.id);
  expect(repeated).toMatchObject({
    started: false,
    noopReason: 'already-compacted',
    compactedMessages: 2,
    checkpointRevision: 1,
  });
  expect(log.requests.filter((item) => item.role === 'context')).toHaveLength(1);

  const nextTask = f.runtime.enqueue(f.conversation.id, randomUUID(), '요약 이어서 다음 작업');
  await Promise.all(f.work);
  expect(f.workspace.task(nextTask.id).status).toBe('completed');
  const nextHelperRequest = log.requests.at(-1)!;
  expect(nextHelperRequest.role).toBe('helper');
  expect(nextHelperRequest.input.history).toEqual([]);
  expect(JSON.stringify(nextHelperRequest.input.source)).toContain(
    '수동 압축 요약: 초안 핵심 규칙을 정리했다.'
  );
  expect(readHelperContextState(f.store, f.conversation.id)).toMatchObject({
    compactedMessages: 2,
    uncompactedMessages: 2,
    totalMessages: 4,
    compaction: { last: null },
  });
});

test('manual helper compaction enforces busy, codex-native, context-model and concurrent-edit guards', async () => {
  const f = await fixture({ fixed: false });
  let releaseCompaction!: () => void;
  const compactionGate = new Promise<void>((resolve) => {
    releaseCompaction = resolve;
  });
  let startedCompaction!: () => void;
  const compactionStarted = new Promise<void>((resolve) => {
    startedCompaction = resolve;
  });
  script(f, async (request) => {
    if (request.role === 'context') {
      startedCompaction();
      await compactionGate;
      return summarized('진행 중 정리 결과');
    }
    return structuredClone(success);
  });

  expect((await f.run()).status).toBe('completed');

  expect(f.runtime.compactConversation(f.conversation.id)).toMatchObject({ started: true });
  try {
    await compactionStarted;
    expect(() => f.runtime.compactConversation(f.conversation.id)).toThrow(
      expect.objectContaining({ statusCode: 409, message: 'HELPER_COMPACTION_BUSY' })
    );
    expect(() => f.runtime.enqueue(f.conversation.id, randomUUID(), '겹치는 요청')).toThrow(
      'HELPER_COMPACTION_BUSY'
    );
    expect(f.runtime.deletionImpact(f.conversation.id).canDelete).toBe(false);
  } finally {
    releaseCompaction();
  }
  await Promise.all(f.work);
  expect(compactionState(f).last?.status).toBe('completed');

  const selected = modelWorkspace(f.store);
  updateModelWorkspace(f.store, {
    expectedRevision: selected.revision,
    routes: selected.routes,
    translationPolicy: selected.translationPolicy,
    helperModel: { id: f.helperModel.id },
    contextModel: null,
  });
  expect(() => f.runtime.compactConversation(f.conversation.id)).toThrow(
    expect.objectContaining({ statusCode: 409, message: 'MODEL_REQUIRED:context' })
  );

  const nativeConnection = f.store.product.connection({
    title: 'Synthetic native codex',
    protocol: 'codex-app-server-v1',
    endpoint: 'codex://local',
    enabled: true,
  });
  const nativeModel = f.store.product.model({
    title: 'Synthetic native codex',
    connectionId: nativeConnection.id,
    modelId: 'codex-native',
    temperature: null,
    maxOutputTokens: 1024,
    inputTokenLimit: 32768,
  });
  const updated = modelWorkspace(f.store);
  updateModelWorkspace(f.store, {
    expectedRevision: updated.revision,
    routes: updated.routes,
    translationPolicy: updated.translationPolicy,
    helperModel: { id: nativeModel.id },
    contextModel: { id: f.contextModel.id },
  });
  expect(() => f.runtime.compactConversation(f.conversation.id)).toThrow(
    expect.objectContaining({ statusCode: 409, message: 'HELPER_COMPACTION_CODEX_NATIVE' })
  );
});

test('an edited helper summary becomes a new edit checkpoint that the next task sends, and carries the compaction estimate across edits', async () => {
  const f = await fixture({ fixed: false });
  const log = script(f, (request) =>
    request.role === 'context' ? summarized('정리한 요약: 초안 규칙') : structuredClone(success)
  );
  const app = Fastify();
  helperRoutes(app, f.runtime);
  expect((await f.run()).status).toBe('completed');
  const { last: compacted } = await compactNow(f);
  if (compacted?.status !== 'completed') throw new Error('compaction did not complete');
  const manualRow = checkpointRows(f)[0] as Record<string, unknown>;

  const url = `/api/helper/conversations/${f.conversation.id}/context`;
  expect((await app.inject({ url })).json()).toMatchObject({
    checkpointRevision: 1,
    summary: '정리한 요약: 초안 규칙',
    origin: 'manual',
    compactedMessages: 2,
    totalMessages: 2,
    summaryTokens: expect.any(Number),
    budgetTokens: expect.any(Number),
    editable: true,
    blockedReason: null,
  });
  const empty = await app.inject({
    method: 'PUT',
    url: `${url}/summary`,
    payload: { expectedRevision: 1, summary: '  ' },
  });
  expect([empty.statusCode, empty.json().message]).toEqual([400, 'HELPER_SUMMARY_EMPTY']);

  const edited = f.runtime.editContextSummary(f.conversation.id, 1, '사용자가 고친 요약');
  expect(edited).toMatchObject({
    checkpointRevision: 2,
    summary: '사용자가 고친 요약',
    origin: 'edit',
  });
  const rows = checkpointRows(f) as Record<string, unknown>[];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ origin: 'edit', revision: 2, activated: 1 });
  expect(JSON.parse(String(rows[0].plan)).compacted).toEqual(
    JSON.parse(String(manualRow.plan)).compacted
  );
  const afterFirst = compactionState(f).last;
  expect(afterFirst).toMatchObject({
    status: 'completed',
    origin: 'edit',
    beforeTokens: compacted.beforeTokens,
    compactedMessages: 2,
  });
  f.runtime.editContextSummary(f.conversation.id, 2, '사용자가 다시 고친 요약, 조금 더 길게');
  const afterSecond = compactionState(f).last;
  expect(afterSecond).toMatchObject({ origin: 'edit', beforeTokens: compacted.beforeTokens });
  if (afterFirst?.status !== 'completed' || afterSecond?.status !== 'completed')
    throw new Error('edit outcome missing');
  expect(afterSecond.afterTokens).toBeGreaterThan(afterFirst.afterTokens);
  expect(
    f.runtime.editContextSummary(f.conversation.id, 3, '사용자가 다시 고친 요약, 조금 더 길게')
  ).toMatchObject({ checkpointRevision: 3 });

  expect(() => f.runtime.editContextSummary(f.conversation.id, 2, '늦게 도착한 편집')).toThrow(
    expect.objectContaining({ statusCode: 409, message: 'HELPER_CONTEXT_DEPENDENCY_CHANGED' })
  );
  expect(() =>
    f.runtime.editContextSummary(f.conversation.id, 3, 'too long summary '.repeat(4000))
  ).toThrow(expect.objectContaining({ statusCode: 400, message: 'HELPER_SUMMARY_TOO_LARGE' }));
  expect(checkpointRows(f)).toHaveLength(1);

  const next = f.runtime.enqueue(f.conversation.id, randomUUID(), '고친 요약으로 이어서');
  await Promise.all(f.work);
  expect(f.workspace.task(next.id).status).toBe('completed');
  const request = log.requests.at(-1)!;
  expect(request.input.history).toEqual([]);
  expect(JSON.stringify(request.input.source)).toContain('사용자가 다시 고친 요약, 조금 더 길게');
  expect(compactionState(f).last).toBeNull();
  await app.close();
});

test('the helper summary cannot change while a task or a compaction runs', async () => {
  const f = await fixture({ fixed: false });
  let release!: () => void;
  let reached!: () => void;
  let gate: Promise<void> | null = null;
  const hold = () =>
    new Promise<void>((resolve) => {
      reached = resolve;
    });
  script(f, async (request) => {
    if (gate) {
      reached();
      await gate;
    }
    return request.role === 'context' ? summarized('막힌 요약') : structuredClone(success);
  });
  expect((await f.run()).status).toBe('completed');
  await compactNow(f);
  const blocked = (attempt: () => unknown) =>
    expect(attempt).toThrow(
      expect.objectContaining({ statusCode: 409, message: 'HELPER_COMPACTION_BUSY' })
    );

  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = hold();
  f.runtime.enqueue(f.conversation.id, randomUUID(), '오래 걸리는 작업');
  await started;
  expect(f.runtime.contextSummary(f.conversation.id)).toMatchObject({
    editable: false,
    blockedReason: 'HELPER_COMPACTION_BUSY',
  });
  blocked(() => f.runtime.editContextSummary(f.conversation.id, 1, '작업 중 편집'));
  blocked(() => f.runtime.resetContextSummary(f.conversation.id, 1));
  release();
  gate = null;
  await Promise.all(f.work);

  const revision = f.runtime.contextSummary(f.conversation.id).checkpointRevision;
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  started = hold();
  expect(f.runtime.compactConversation(f.conversation.id)).toMatchObject({ started: true });
  await started;
  blocked(() => f.runtime.editContextSummary(f.conversation.id, revision, '정리 중 편집'));
  blocked(() => f.runtime.resetContextSummary(f.conversation.id, revision));
  release();
  gate = null;
  await Promise.all(f.work);
  expect(f.runtime.contextSummary(f.conversation.id).summary).toBe('막힌 요약');
});

test('resetting the helper summary sends the full history next and reports nothing compacted', async () => {
  const f = await fixture({ fixed: false });
  const log = script(f, (request) =>
    request.role === 'context' ? summarized('지울 요약') : structuredClone(success)
  );
  expect((await f.run()).status).toBe('completed');
  await compactNow(f);
  expect(() => f.runtime.resetContextSummary(f.conversation.id, 0)).toThrow(
    expect.objectContaining({ statusCode: 409, message: 'HELPER_CONTEXT_DEPENDENCY_CHANGED' })
  );
  expect(f.runtime.resetContextSummary(f.conversation.id, 1)).toMatchObject({
    checkpointRevision: 2,
    summary: null,
    compactedMessages: 0,
    editable: false,
  });
  expect(readHelperContextState(f.store, f.conversation.id)).toMatchObject({
    compactedMessages: 0,
    uncompactedMessages: 2,
    summaryChars: 0,
    compaction: { last: { status: 'completed', origin: 'reset', compactedMessages: 0 } },
  });
  expect(checkpointRows(f)).toEqual([]);
  expect(f.runtime.resetContextSummary(f.conversation.id, 0)).toMatchObject({
    checkpointRevision: 2,
  });
  expect(() => f.runtime.editContextSummary(f.conversation.id, 2, '없는 요약 편집')).toThrow(
    expect.objectContaining({ statusCode: 409, message: 'HELPER_CONTEXT_DEPENDENCY_CHANGED' })
  );

  const next = f.runtime.enqueue(f.conversation.id, randomUUID(), '전체 대화로 이어서');
  await Promise.all(f.work);
  expect(f.workspace.task(next.id).status).toBe('completed');
  const request = log.requests.at(-1)!;
  expect(request.input.history).toHaveLength(2);
  expect(JSON.stringify(request.input.source)).not.toContain('지울 요약');
});

function compactionState(f: Fixture) {
  return readHelperContextState(
    f.store,
    f.conversation.id,
    f.runtime.compactionRunning(f.conversation.id)
  ).compaction;
}
function seed(f: Fixture, id: string, text: string) {
  f.store.db
    .prepare('INSERT INTO helper_seed_messages VALUES(?,?,?,?,?,?)')
    .run(id, f.conversation.id, 0, 'user', text, new Date().toISOString());
}
async function compactNow(f: Fixture) {
  const started = f.runtime.compactConversation(f.conversation.id);
  await Promise.all(f.work);
  return { started, last: compactionState(f).last };
}
const failedWith = (code: string): transport.ProviderResult => ({
  ...structuredClone(success),
  status: 'error',
  text: '',
  error: { code },
});

test.each<[string, transport.ProviderResult, string]>([
  ['auth', failedWith('HTTP_401'), 'HELPER_COMPACTION_AUTH'],
  [
    'refusal',
    { ...structuredClone(success), status: 'refused', text: '', refusal: 'policy' },
    'HELPER_COMPACTION_REFUSED',
  ],
  ['empty output', summarized('  '), 'HELPER_COMPACTION_EMPTY'],
  [
    'output limit',
    { ...failedWith('MAX_TOKENS'), status: 'partial', text: '잘린 요약' },
    'HELPER_COMPACTION_EMPTY',
  ],
  ['eof', failedWith('UNEXPECTED_EOF'), 'HELPER_COMPACTION_EOF'],
  ['provider timeout', failedWith('TIMEOUT'), 'HELPER_COMPACTION_TIMEOUT'],
  ['other provider error', failedWith('INVALID_EVENT'), 'HELPER_COMPACTION_FAILED'],
])(
  'a manual compaction %s failure is recorded with a specific code',
  async (_name, reply, code) => {
    const f = await fixture({ fixed: false });
    script(f, (request) =>
      request.role === 'context' ? structuredClone(reply) : structuredClone(success)
    );
    expect((await f.run()).status).toBe('completed');
    const { last } = await compactNow(f);
    expect(last).toMatchObject({ status: 'failed', code });
    expect(checkpointRows(f)).toEqual([]);
    expect(readHelperContextState(f.store, f.conversation.id).uncompactedMessages).toBe(2);
  }
);

test('manual compaction retries an overloaded summary provider, then reports what remains', async () => {
  const delays: number[] = [];
  const f = await fixture({
    fixed: false,
    wait: async (ms) => {
      delays.push(ms);
    },
  });
  let contextCalls = 0;
  script(f, (request) => {
    if (request.role !== 'context') return structuredClone(success);
    return ++contextCalls <= 2 ? failedWith('HTTP_529') : summarized('재시도 후 정리한 요약');
  });
  expect((await f.run()).status).toBe('completed');
  expect((await compactNow(f)).last).toMatchObject({ status: 'completed' });
  expect(contextCalls).toBe(3);
  expect(delays).toEqual(HELPER_PROVIDER_RETRY_DELAYS_MS.slice(0, 2));

  f.conversation = f.workspace.open({ kind: 'library', workId: 'overloaded' });
  contextCalls = -10;
  expect((await f.run()).status).toBe('completed');
  expect((await compactNow(f)).last).toMatchObject({
    status: 'failed',
    code: 'HELPER_COMPACTION_OVERLOADED',
  });
  expect(contextCalls).toBe(-10 + HELPER_PROVIDER_RETRY_DELAYS_MS.length + 1);
});

test('manual compaction splits a request that exceeds the provider request size instead of failing', async () => {
  const f = await fixture({ fixed: false });
  seed(f, 'seed-long', 'Long helper conversation record. '.repeat(1_500));
  const parts: number[] = [];
  script(f, (request) => {
    parts.push(Number(request.input.controls.part));
    return summarized(`part ${parts.length}`);
  });
  const measure = mainRequest.measureProviderRequest;
  vi.spyOn(mainRequest, 'measureProviderRequest').mockImplementation((request, target) => {
    if (JSON.stringify(request.input.source).length > 30_000)
      throw new transport.ProviderContractError('REQUEST_TOO_LARGE');
    return measure(request, target);
  });
  const { last } = await compactNow(f);
  expect(last).toMatchObject({ status: 'completed', compactedMessages: 1 });
  expect(parts).toEqual([1, 2]);
});

test('manual compaction keeps running after the request returns, shows progress, and can be cancelled', async () => {
  const f = await fixture({ fixed: false });
  const app = Fastify();
  helperRoutes(app, f.runtime);
  let release!: () => void;
  let started!: () => void;
  const reached = new Promise<void>((resolve) => {
    started = resolve;
  });
  script(f, async (request, _index) => {
    if (request.role !== 'context') return structuredClone(success);
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return summarized('요청이 끝난 뒤 완료한 요약');
  });
  expect((await f.run()).status).toBe('completed');
  const view = async () =>
    (await app.inject({ url: `/api/helper/conversations/${f.conversation.id}/view` })).json()
      .context.compaction;

  const response = await app.inject({
    method: 'POST',
    url: `/api/helper/conversations/${f.conversation.id}/compact`,
    payload: {},
  });
  expect(response.json()).toMatchObject({ started: true, startedAt: expect.any(String) });
  await reached;
  expect(await view()).toMatchObject({ running: { startedAt: expect.any(String) }, last: null });
  release();
  await Promise.all(f.work);
  expect(await view()).toMatchObject({ running: null, last: { status: 'completed' } });

  f.conversation = f.workspace.open({ kind: 'library', workId: 'cancel' });
  expect((await f.run()).status).toBe('completed');
  const cancelled = new Promise<void>((resolve) => {
    started = resolve;
  });
  await app.inject({
    method: 'POST',
    url: `/api/helper/conversations/${f.conversation.id}/compact`,
    payload: {},
  });
  await cancelled;
  const cancel = await app.inject({
    method: 'DELETE',
    url: `/api/helper/conversations/${f.conversation.id}/compact`,
    payload: {},
  });
  expect(cancel.json()).toEqual({ cancelled: true });
  release();
  await Promise.all(f.work);
  expect(await view()).toMatchObject({
    running: null,
    last: { status: 'failed', code: 'HELPER_COMPACTION_CANCELLED' },
  });
  expect(checkpointRows(f)).toEqual([]);
  await app.close();
});

test('manual compaction sends only attachments the summary model accepts', async () => {
  const f = await fixture({ fixed: false });
  seed(f, 'seed-image', '첨부 이미지를 참고해 줘.');
  const image = {
    hash: 'a'.repeat(64),
    mime: 'image/webp' as const,
    name: 'reference.webp',
    width: 1,
    height: 1,
    input: { hash: 'b'.repeat(64), width: 1, height: 1 },
  };
  vi.spyOn(helperAttachments, 'helperMessageAttachments').mockImplementation((_db, id) =>
    id === 'seed-image' ? { images: [image] } : {}
  );
  const deepseek = f.store.product.connection({
    title: 'Synthetic text-only context',
    protocol: 'deepseek-chat-v1',
    endpoint: 'https://api.deepseek.com',
    apiKey: 'SYNTHETIC',
    enabled: true,
  });
  const textOnly = f.store.product.model({
    title: 'Synthetic text-only context',
    connectionId: deepseek.id,
    modelId: 'deepseek-v4-pro',
    temperature: null,
    maxOutputTokens: 8192,
    inputTokenLimit: 65536,
  });
  const selected = modelWorkspace(f.store);
  updateModelWorkspace(f.store, {
    expectedRevision: selected.revision,
    routes: selected.routes,
    translationPolicy: selected.translationPolicy,
    helperModel: { id: f.helperModel.id },
    contextModel: { id: textOnly.id },
  });
  const sent: transport.ProviderRequest[] = [];
  vi.spyOn(transport, 'executeProvider').mockImplementation(async (_connection, request) => {
    encodeMainPreview(request, f.store.product.modelSnapshot(textOnly.id));
    sent.push(structuredClone(request));
    return summarized('첨부 없이 정리한 요약');
  });
  const { last } = await compactNow(f);
  expect(last).toMatchObject({ status: 'completed' });
  expect(sent).toHaveLength(1);
  expect(sent[0].prompt).toBeUndefined();
  expect(JSON.stringify(sent[0].input.source)).toContain('reference.webp');
});
