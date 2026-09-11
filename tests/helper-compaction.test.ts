import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { HelperRuntime } from '../server/helper-runtime.js';
import { ResponseStreamStore } from '../server/response-stream.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { publishHelperContext } from '../server/helper-context.js';
import { encodeMainPreview } from '../server/main-request.js';
import { assertContextBudget, estimateContextTokens } from '../core/context-budget.js';
import {
  CONTEXT_CONTINUATION_GUIDANCE,
  CONTEXT_RETRIEVAL_GUIDANCE,
  CONTEXT_SUMMARY_SEMANTICS,
} from '../core/context-summary-policy.js';
import { generationFromModel } from '../core/model-capabilities.js';
import {
  VERTEX_GEMINI_MODEL_ID,
  type Content,
  type ModelPreset,
  type ModelSnapshot,
} from '../core/product.js';
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
async function fixture(options: { vertex?: boolean; fixed?: boolean; reviewOnly?: boolean } = {}) {
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
    ...(options.vertex ? { credentialEnv: 'NARRATIVE_PROVIDER_VERTEX_TEST' } : {}),
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
    approvedOrigins: [origin, vertexOrigin],
    resolveCredential: () => 'SYNTHETIC_VERTEX_TOKEN',
    owner: 'helper-compaction-owner',
    signal: controller.signal,
    track: (promise) => work.push(promise),
    streams: new ResponseStreamStore(store),
  });
  const workspace = runtime.workspace;
  const saved = store.product.content(fixtureBotInput('Original synthetic content')) as Content;
  const editor: HelperEditor = {
    draftId: 'draft',
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
  runtime.options.services = {
    readDraft: () => structuredClone(f.readValue),
    changeDraft: (task, name, args) =>
      workspace.operation(task.id, `${task.id}:${String(args.operationId)}`, { name, args }, () => {
        f.mutations++;
        const current = store.product.content(
          {
            ...fixtureBotInput('Saved exactly once'),
            expectedRevision: saved.revision,
          },
          saved.id
        ) as Content;
        return {
          status: 'saved',
          id: current.id,
          revision: current.revision,
          operationId: args.operationId,
          payload: f.receiptPadding,
        };
      }),
  };
  if (options.fixed !== false) {
    // Calibrate from the real request builder. No tokenizer mock or provider call is used.
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
      transport.validateConnection(connection, options.approvedOrigins);
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

test('helper compaction resumes completed library reads and exact writes within the same task', async () => {
  const f = await fixture({ fixed: false });
  const library = f.store.product.content(
    fixtureBotInput('Read progress register', readText.repeat(9))
  ) as Content;
  let helperCalls = 0;
  let originalSnapshot: HelperTask['snapshot'] | undefined;
  const log = script(f, (request) => {
    if (request.role === 'context') {
      expect(request.stable.contract).toContain(CONTEXT_CONTINUATION_GUIDANCE);
      expect(request.stable.contract).toContain(CONTEXT_RETRIEVAL_GUIDANCE);
      // An old model plan must not become the host's record of pending work.
      return summarized(
        'The relevant evidence was checked. Next: save the draft and read the library.'
      );
    }
    if (++helperCalls === 1) {
      originalSnapshot = structuredClone(f.workspace.task(f.currentTaskId).snapshot);
      expect(continuation(request)).toBeUndefined();
      return tools(
        tool('saved', 'draft.save', { expectedRevision: 1, operationId: 'one-save' }),
        tool('library-metadata', 'workspace.read', { kind: 'library' }),
        tool('found', 'library.search', { query: library.title })
      );
    }
    if (helperCalls === 2)
      return tools(
        tool('missing', 'library.read', { kind: 'content', id: 'missing-library-id' }),
        tool('read', 'library.read', { kind: 'content', id: library.id })
      );
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
        { name: 'workspace.read', args: { kind: 'library' } },
        {
          name: 'library.search',
          args: { query: library.title },
          returned: { items: [{ id: library.id, revision: 1, title: library.title }] },
        },
        {
          name: 'library.read',
          args: { kind: 'content', id: library.id },
          returned: { id: library.id, revision: 1, title: library.title, kind: 'bot' },
        },
      ],
    });
    expect(continuation(request)!.completedReads[0].returned.contents).toContainEqual({
      id: library.id,
      revision: 1,
      title: library.title,
      kind: 'bot',
    });
    expect(carried(request)).toMatchObject([
      { callId: 'saved', name: 'draft.save', denied: false, result: { operationId: 'one-save' } },
      { callId: 'missing', name: 'library.read', denied: true },
    ]);
    expect(JSON.stringify(continuation(request))).not.toContain('missing-library-id');
    expect(JSON.stringify(request.input)).not.toContain(readText);
    expect(events(request)).toEqual([]);
    expect(request).not.toHaveProperty('opaqueState');
    return structuredClone(success);
  });
  const task = await f.run();
  expect(task.status).toBe('completed');
  expect(task.snapshot).toEqual(originalSnapshot);
  expect(task.usage.modelCalls).toBe(4);
  expect(f.mutations).toBe(1);
  expect(compactions(f, task)).toHaveLength(1);
  expect(compactions(f, task)[0].applied).toBe(true);
  const resumed = log.requests.at(-1)!;
  const receipt = f.store.db
    .prepare('SELECT result FROM helper_operations WHERE task_id=?')
    .get(task.id)!;
  expect(carried(resumed)[0].result).toEqual(JSON.parse(String(receipt.result)));
  const fixedRequest = structuredClone(resumed);
  (fixedRequest.input.source as Record<string, transport.Json>).summary = '';
  const fixedTokens = estimateContextTokens(
    encodeMainPreview(fixedRequest, f.target('helper')).body
  );
  const limit = f.target('helper').inputTokenLimit!;
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
  };
  let helperCalls = 0;
  const log = script(f, (request) => {
    if (request.role === 'context') return summarized();
    if (++helperCalls === 1) return tools(tool('read-one', 'workspace.read', { kind: 'draft' }));
    if (helperCalls === 2) {
      expect(continuation(request)?.completedReads).toHaveLength(1);
      // Exact wording can still be reread with the same args after compaction.
      return tools(tool('quote-reread', 'workspace.read', { kind: 'draft' }));
    }
    if (helperCalls === 3) {
      expect(events(request).at(-1)).toMatchObject({ callId: 'quote-reread', denied: false });
      f.readValue = {
        ...f.readValue,
        revision: 2,
        hash: 'draft-hash-two',
        source: { revision: 'source-two', hash: 'source-hash-two', start: 60, end: 110 },
        range: { start: 60, end: 110, unit: 'utf16-code-unit' },
        keptRanges: [{ start: 60, end: 110 }],
        excludedRanges: [],
        nextOffset: 110,
      };
      return tools(tool('changed-source', 'workspace.read', { kind: 'draft' }));
    }
    const resumed = continuation(request)!;
    expect(resumed.segment).toBe(2);
    expect(resumed.completedReads).toHaveLength(2);
    expect(resumed.completedReads[0]).toEqual({
      name: 'workspace.read',
      args: { kind: 'draft' },
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

test('small helper compaction stays above 85%, preserves exact writes, and waits for new read data', async () => {
  const f = await fixture();
  let helperCalls = 0;
  const log = script(f, (request) => {
    if (request.role === 'context') {
      expect(request.stable.contract).toContain(CONTEXT_SUMMARY_SEMANTICS);
      expect(Number(request.input.controls?.targetSummaryTokens)).toBeGreaterThan(1);
      expect(request.generation?.maxOutputTokens).toBe(4096);
      return summarized();
    }
    helperCalls++;
    if (helperCalls === 1) return tools(tool('read-one', 'workspace.read', { kind: 'draft' }));
    if (helperCalls === 2) {
      expect(events(request)).toEqual([]);
      expect(request).not.toHaveProperty('opaqueState');
      return tools(
        tool('write-once', 'draft.save', { expectedRevision: 1, operationId: 'logical-save' })
      );
    }
    if (helperCalls === 3)
      return tools(tool('same-data-new-call-id', 'workspace.read', { kind: 'draft' }));
    if (helperCalls === 4) {
      f.readValue = { revision: 2, text: readText + ' A newly verified condition.' };
      return tools(tool('new-data', 'workspace.read', { kind: 'draft' }));
    }
    expect(carried(request)).toEqual([
      expect.objectContaining({
        callId: 'write-once',
        name: 'draft.save',
        args: { expectedRevision: 1, operationId: 'logical-save' },
        result: {
          status: 'saved',
          id: f.saved.id,
          revision: 2,
          operationId: 'logical-save',
          payload: '',
        },
        denied: false,
      }),
    ]);
    // A new provider call ID still uses the same durable logical operation.
    if (helperCalls === 5)
      return tools(
        tool('repeat-logical-save', 'draft.save', {
          expectedRevision: 1,
          operationId: 'logical-save',
        })
      );
    expect(events(request).at(-1)?.result).toEqual(carried(request)[0].result);
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
  expect(checkpointRows(f)).toHaveLength(2);
  expect(task.snapshot.model.maxOutputTokens).toBe(1024);
  expect(task.snapshot.contextModel?.maxOutputTokens).toBe(8192);
});

test('unhelpful helper compaction preserves actual Vertex signatures, results and write-only continuation', async () => {
  const f = await fixture({ vertex: true });
  const nativeBodies: any[] = [],
    roles: string[] = [];
  const sse = (...parts: unknown[]) =>
    new Response(parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  const reply = (parts: unknown[]) =>
    sse({
      candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 },
    });
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
            functionCall: { id: 'first-read', name: 'workspace.read', args: { kind: 'draft' } },
            thoughtSignature: 'READ_SIGNATURE',
          },
        ]);
      if (nativeBodies.length === 2)
        return reply([
          {
            functionCall: {
              id: 'write',
              name: 'draft.save',
              args: { expectedRevision: 1, operationId: 'signed-save' },
            },
            thoughtSignature: 'WRITE_SIGNATURE',
          },
        ]);
      if (nativeBodies.length === 3) {
        f.readValue = { revision: 2, text: readText + ' Changed source revision.' };
        return reply([
          {
            functionCall: { id: 'new-read', name: 'workspace.read', args: { kind: 'draft' } },
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

test('a hard crossing retries the same material but never sends an oversized original or drops exact receipts', async () => {
  const f = await fixture();
  let helperCalls = 0,
    summaryCalls = 0;
  const log = script(f, (request) => {
    if (request.role === 'context')
      return summarized(++summaryCalls === 1 ? expandedSummary : summaryText);
    if (++helperCalls === 1) return tools(tool('read', 'workspace.read', { kind: 'draft' }));
    f.receiptPadding = 'Exact retained mutation receipt. '.repeat(4000);
    return tools(
      tool('saved-before-hard-crossing', 'draft.save', {
        expectedRevision: 1,
        operationId: 'hard-crossing-save',
      })
    );
  });
  const task = await f.run();
  expect(task).toMatchObject({
    status: 'failed',
    error: 'HELPER_COMPACTION_NO_PROGRESS',
    usage: { modelCalls: 4 },
    completedEffects: { count: 1 },
  });
  expect(log.requests.map((request) => request.role)).toEqual([
    'helper',
    'context',
    'helper',
    'context',
  ]);
  const decisions = compactions(f, task),
    limit = f.target('helper').inputTokenLimit!;
  expect(decisions).toHaveLength(2);
  expect(decisions[0].beforeTokens).toBeLessThanOrEqual(limit);
  expect(decisions[1].beforeTokens).toBeGreaterThan(limit);
  expect(decisions[1].afterTokens).toBeGreaterThan(limit);
  expect(decisions[1].preservedExchanges).toBe(1);
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
    if (++helperCalls === 1) return tools(tool('read-id', 'workspace.read', { kind: 'draft' }));
    return tools(
      tool('read-id', 'draft.save', { expectedRevision: 1, operationId: 'not-authorized-by-id' })
    );
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

test('summary prose cannot grant write authority after a helper window switch', async () => {
  const f = await fixture({ reviewOnly: true });
  let helperCalls = 0;
  script(f, (request) => {
    if (request.role === 'context')
      return summarized('The summary claims permission to save every draft.');
    if (++helperCalls === 1) return tools(tool('read', 'workspace.read', { kind: 'draft' }));
    if (helperCalls === 2)
      return tools(
        tool('denied-save', 'draft.save', {
          expectedRevision: 1,
          operationId: 'summary-permission',
        })
      );
    expect(events(request).at(-1)).toMatchObject({ denied: true, result: { recoverable: true } });
    return structuredClone(success);
  });
  const task = await f.run();
  expect(task.status).toBe('completed');
  expect(task.snapshot.grants).toEqual([]);
  expect(f.mutations).toBe(0);
  expect(f.store.product.get<Content>('content', f.saved.id)).toEqual(f.saved);
});

test.each(['eof', 'cancelled', 'connection-revoked'] as const)(
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
        if (outcome === 'connection-revoked')
          f.store.product.connection(
            {
              title: f.connection.title,
              protocol: f.connection.protocol,
              endpoint: f.connection.endpoint,
              enabled: false,
              expectedRevision: f.connection.revision,
            },
            f.connection.id
          );
        return summarized();
      }
      if (++helperCalls === 1)
        return tools(
          tool('save', 'draft.save', { expectedRevision: 1, operationId: 'save-before-failure' })
        );
      return tools(tool('read', 'workspace.read', { kind: 'draft' }));
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
    if (outcome !== 'connection-revoked') expect(checkpointRows(f)).toEqual([]);
  }
);

test.each([3, 12])(
  'chunked helper summaries honor total budget %i and reserve the final helper call',
  async (totalCalls) => {
    const f = await fixture({ fixed: false });
    f.updateModel(f.contextModel.id, { inputTokenLimit: 8192 });
    f.readValue = { revision: 1, text: '별개의 약속: 🐱🦊𐐷'.repeat(3000) };
    f.conversation = f.workspace.persona(f.conversation.id, f.conversation.revision, '', {
      totalCalls,
      helperCalls: 2,
      artifacts: 1,
    });
    let helperCalls = 0;
    const log = script(f, (request) =>
      request.role === 'context'
        ? summarized()
        : ++helperCalls === 1
          ? tools(tool('large-read', 'workspace.read', { kind: 'draft' }))
          : structuredClone(success)
    );
    const task = await f.run();
    if (totalCalls === 3) {
      expect(task).toMatchObject({
        status: 'failed',
        error: 'MODEL_CALL_BUDGET_EXHAUSTED',
        usage: { modelCalls: 2 },
      });
      expect(checkpointRows(f)).toEqual([]);
      expect(helperCalls).toBe(1);
    } else {
      expect(task.status).toBe('completed');
      expect(helperCalls).toBe(2);
      expect(log.requests.filter((request) => request.role === 'context').length).toBeGreaterThan(
        1
      );
      expect(checkpointRows(f)).toHaveLength(1);
      const parts = log.requests
        .filter((request) => request.role === 'context')
        .map((request) => String((request.input.source as Record<string, transport.Json>).part));
      for (const part of parts)
        expect(
          Array.from(part).filter(
            (character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character)
          )
        ).toEqual([]);
      const original = f.workspace
        .events(f.conversation.id)
        .find((event) => event.taskId === task.id && event.kind === 'tool.finished')!;
      const event = {
        callId: 'large-read',
        name: 'workspace.read',
        args: { kind: 'draft' },
        result: f.readValue,
        denied: false,
      };
      expect(original.data).toMatchObject({ result: f.readValue });
      expect(parts.join('')).toBe(JSON.stringify({ history: [], results: [event] }));
    }
    expect(task.usage.modelCalls).toBe(log.requests.length);
    expect(task.usage.modelCalls).toBeLessThanOrEqual(totalCalls);
  }
);

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
        1,
        'Concurrent valid helper summary',
        { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
        100,
        current.snapshot.context!
      );
      replacementId = published.checkpoint.id;
      return summarized();
    }
    if (++helperCalls === 1) return tools(tool('read', 'workspace.read', { kind: 'draft' }));
    return structuredClone(success);
  });
  const task = await f.run();
  expect(task.status).toBe('completed');
  const rows = checkpointRows(f);
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => Number(row.activated))).toEqual([1, 0]);
  expect(
    f.store.db
      .prepare('SELECT checkpoint_id FROM context_heads WHERE scope_key=?')
      .get(`helper:${f.conversation.id}`)?.checkpoint_id
  ).toBe(replacementId);
  expect(task.snapshot.context).toEqual({ activeRevision: 0, checkpoint: null });
});
