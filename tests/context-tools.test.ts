import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { defaultProfile, type ModelSnapshot, VERTEX_GEMINI_MODEL_ID } from '../core/product.js';
import type { RunSnapshot, ToolEvent } from '../core/types.js';
import type { Json } from '../core/transport.js';
import {
  CONTEXT_TOOL_NAMES,
  contextToolsEnabled,
  contextWindowStatus,
} from '../core/context-tools.js';
import { encodeResponses } from '../core/openai-protocol.js';
import { encodeChat } from '../core/openai-chat-protocol.js';
import { encodeAnthropic } from '../core/anthropic-protocol.js';
import { encodeVertex } from '../core/vertex-protocol.js';
import {
  measureMainContext,
  seedContextPlan,
  withContextProjection,
} from '../server/context-planning.js';
import { executeContextTool, type ContextPersistence } from '../server/context-tools.js';
import { buildMainProviderRequest } from '../server/main-request.js';
import { runMain, type MainHooks } from '../server/model-runner.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const origin = 'http://127.0.0.1:44998';
const chapters = Array.from({ length: 5 }, (_, index) =>
  `CHAPTER_${index}_CANARY 미라는 항구에서 약속 ${index}을 기억해요.\n`.repeat(4)
);
const workingSummary =
  'WORKING_SUMMARY_CANARY: 미라와 선장의 관계는 3장에서 화해로 정리했고, 등불 약속은 아직 미해결이에요.';
const finalText = '미라는 등불을 들고 부두 끝으로 걸어갔어요.';
const model = (contextTools = true): ModelSnapshot => ({
  id: 'main-model',
  revision: 1,
  title: 'main-model',
  modelId: 'fixture-main',
  connectionId: 'connection-main',
  inputTokenLimit: 16384,
  maxOutputTokens: 4096,
  temperature: null,
  ...(contextTools ? { contextTools: true } : {}),
  connection: {
    id: 'connection-main',
    revision: 1,
    title: 'Synthetic loopback only',
    protocol: 'fixture-sse-v1',
    endpoint: `${origin}/turn`,
    enabled: true,
    catalog: [],
    catalogError: null,
  },
});
/** A frozen main run input whose context plan is already prepared, as app.ts hands it to runMain. */
function snapshot(contextTools = true): RunSnapshot {
  const target = model(contextTools);
  const history = chapters.map((text, index) => ({
    revision: `chapter-${index}`,
    text,
    contentHash: hash(text),
  }));
  const seeded = seedContextPlan({
    chatId: 'synthetic-context-tools-chat',
    parentRevision: history.at(-1)!.revision,
    settingsRevision: 1,
    settings: { preset: 'calm', mode: 'direct', translation: false, status: false, maxCalls: 8 },
    request: 'CURRENT_REQUEST_CANARY: 등불 약속을 이어서 써 주세요.',
    history,
    resources: [],
    logicalHistory: history.flatMap((source) => [
      {
        id: `request:${source.revision}`,
        role: 'user' as const,
        text: `USER_${source.revision}: 계속해 주세요.`,
        sourceRevision: source.revision,
        sourceHash: source.contentHash,
      },
      {
        id: `source:${source.revision}`,
        role: 'assistant' as const,
        text: source.text,
        sourceRevision: source.revision,
        sourceHash: source.contentHash,
      },
    ]),
    contextBase: {
      scopeKey: 'chat:synthetic-context-tools-chat:main',
      activeRevision: 0,
      notesRevision: 0,
      checkpoint: null,
    },
    profile: {
      ...defaultProfile('synthetic-context-tools-chat'),
      contents: [],
      models: { main: target },
      routes: { main: { id: target.id }, translation: null, status: null, image: null },
      promptPresets: {
        main: {
          id: 'synthetic-prompt',
          revision: 1,
          title: 'Synthetic prompt',
          role: 'main',
          program: {
            version: 1,
            controls: [],
            blocks: [
              {
                id: 'fixed',
                title: 'Fixed',
                kind: 'message',
                role: 'system',
                template: [{ kind: 'text', text: 'FIXED_INSTRUCTIONS_CANARY' }],
              },
              { id: 'history', title: 'History', kind: 'history', from: 0, to: -1 },
              { id: 'current', title: 'Current', kind: 'current' },
            ],
          },
        },
      },
    },
  });
  const ready = withContextProjection(seeded, [], null);
  const measured = measureMainContext(ready);
  return {
    ...measured.snapshot,
    contextPlan: { ...ready.contextPlan!, estimatedInputTokens: measured.estimatedInputTokens },
  };
}
const sse = (...events: unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
const toolTurn = (
  calls: { id: string; name: string; args: Record<string, unknown> }[],
  n: number
) =>
  sse(
    ...calls.map((call, index) => ({
      type: 'tool_delta',
      index,
      id: call.id,
      name: call.name,
      argumentsDelta: JSON.stringify(call.args),
    })),
    { type: 'usage', inputTokens: 11, outputTokens: 7, costUsd: null },
    { type: 'opaque_state', state: `OPAQUE_${n}` },
    { type: 'done', reason: 'tool_calls' }
  );
const completed = () =>
  sse(
    { type: 'text_delta', delta: finalText },
    { type: 'usage', inputTokens: 11, outputTokens: 7, costUsd: null },
    { type: 'done', reason: 'stop' }
  );
type Body = {
  role: string;
  stable: { contract: string; tools: { name: string }[] };
  input: { source: Record<string, Json>; results: ToolEvent[] };
  prompt?: { messages: { content: { text: string }[] }[] };
  bootstrap?: ToolEvent[];
  opaqueState?: Json;
};
const promptText = (body: Body) =>
  body.prompt!.messages.flatMap((message) => message.content.map((part) => part.text)).join('\n');
function persistence(activated = true) {
  const calls: { compacted: number; summary: string | null; own: unknown }[] = [];
  let revision = 0;
  const persist: ContextPersistence = (prepared, own) => {
    revision++;
    calls.push({
      compacted: prepared.contextPlan!.compacted.length,
      summary: prepared.contextPlan!.summary,
      own,
    });
    return {
      snapshot: {
        ...prepared,
        contextPlan: {
          ...prepared.contextPlan!,
          checkpoint: { id: `cp-${revision}`, revision, hash: `hash-${revision}` },
        },
      },
      activated,
    };
  };
  return { persist, calls };
}
function hooks(persist?: ContextPersistence) {
  const events: ToolEvent[] = [];
  const value: MainHooks = {
    signal: new AbortController().signal,
    approvedOrigins: [origin],
    authorize: (connection) => connection,
    onInput: () => {},
    onToolEvent: (event) => {
      events.push(event);
    },
    onAttemptStart: () => 'attempt',
    onAttemptFinish: () => {},
    ...(persist ? { persistContext: persist } : {}),
  };
  return { value, events };
}
function script(rounds: ((body: Body, n: number) => Response)[]) {
  const bodies: Body[] = [];
  vi.mocked(fetch).mockImplementation(async (_url, options) => {
    const body = JSON.parse(String(options?.body)) as Body;
    bodies.push(body);
    const round = rounds[bodies.length - 1];
    if (!round) throw new Error(`Unexpected provider round ${bodies.length}`);
    return round(body, bodies.length);
  });
  return bodies;
}
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('Unexpected provider access in synthetic context tool tests')
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('model-driven working summary and window switch inside one main run', () => {
  test('list, write, switch alone, then read a compacted original through the new window', async () => {
    const saved = persistence();
    const log = hooks(saved.persist);
    const bodies = script([
      (_body, n) => toolTurn([{ id: 'c1', name: 'story.list', args: {} }], n),
      (_body, n) =>
        toolTurn([{ id: 'c2', name: 'context.write', args: { summary: workingSummary } }], n),
      (_body, n) => toolTurn([{ id: 'c3', name: 'context.new', args: { keepRecent: 2 } }], n),
      (_body, n) =>
        toolTurn([{ id: 'c4', name: 'story.read', args: { id: 'chapter-0', limit: 40 } }], n),
      () => completed(),
    ]);
    const result = await runMain(snapshot(), log.value);
    expect(result).toMatchObject({ status: 'completed', text: finalText });
    expect(result.usage.modelCalls).toBe(5);
    expect(bodies).toHaveLength(5);
    const first = bodies[0];
    expect(first.stable.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([...CONTEXT_TOOL_NAMES, 'story.list', 'story.search', 'story.read'])
    );
    expect(first.stable.contract).toContain('Context window tools are registered');
    expect(first.input.source.contextWindow).toMatchObject({
      inputTokenLimit: 16384,
      compactedExchanges: 0,
      retainedExchanges: 5,
    });
    for (const chapter of chapters) expect(promptText(first)).toContain(chapter.slice(0, 16));
    expect(first).not.toHaveProperty('opaqueState');
    expect(bodies[1].opaqueState).toBe('OPAQUE_1');
    expect(bodies[2].opaqueState).toBe('OPAQUE_2');
    expect(log.events.map((event) => event.name)).toEqual([
      'story.list',
      'context.write',
      'context.new',
      'story.read',
    ]);
    const listed = log.events[0].result as {
      results: { revision: string; compacted: boolean }[];
      contextWindow: { estimatedInputTokens: number; inputTokenLimit: number; level: string };
    };
    expect(listed.results.map((item) => item.revision)).toEqual(
      chapters.map((_, i) => `chapter-${i}`)
    );
    expect(listed.results.every((item) => !item.compacted)).toBe(true);
    expect(listed.contextWindow.inputTokenLimit).toBe(16384);
    expect(listed.contextWindow.estimatedInputTokens).toBeGreaterThan(0);
    expect(listed.contextWindow.level).toBe('ok');
    expect(log.events[1].result).toMatchObject({
      saved: true,
      summaryChars: workingSummary.length,
      checkpoint: { id: 'cp-1' },
      activated: true,
      contextWindow: { inputTokenLimit: 16384 },
    });
    expect(saved.calls[0]).toEqual({ compacted: 0, summary: workingSummary, own: null });
    expect(log.events[2].result).toMatchObject({
      switched: true,
      compactedExchanges: 3,
      retained: ['chapter-3', 'chapter-4'],
      droppedToolResults: 2,
      checkpoint: { id: 'cp-2' },
      contextWindow: { inputTokenLimit: 16384 },
    });
    expect(saved.calls[1]).toEqual({
      compacted: 3,
      summary: workingSummary,
      own: { id: 'cp-1', revision: 1, hash: 'hash-1' },
    });
    // The new window is a fresh request: no continuation, no earlier results, one carried exchange.
    const fresh = bodies[3];
    expect(fresh).not.toHaveProperty('opaqueState');
    expect(fresh.input.results).toEqual([]);
    expect(fresh.bootstrap!.map((item) => item.name)).toEqual(['context.new']);
    expect((fresh.bootstrap![0].result as { switched: boolean }).switched).toBe(true);
    const text = promptText(fresh);
    for (const index of [0, 1, 2]) expect(text).not.toContain(`CHAPTER_${index}_CANARY`);
    for (const index of [3, 4]) expect(text).toContain(`CHAPTER_${index}_CANARY`);
    expect(text).toContain(workingSummary);
    expect(text).toContain('FIXED_INSTRUCTIONS_CANARY');
    expect(text).toContain('CURRENT_REQUEST_CANARY');
    expect(fresh.input.source.contextWindow).toMatchObject({
      compactedExchanges: 3,
      retainedExchanges: 2,
      summaryChars: workingSummary.length,
    });
    expect(fresh.stable.tools.map((tool) => tool.name)).toEqual(
      first.stable.tools.map((tool) => tool.name)
    );
    const reread = log.events[3].result as { text: string; source: { revision: string } };
    expect(reread.source.revision).toBe('chapter-0');
    expect(chapters[0].startsWith(reread.text)).toBe(true);
    expect(bodies[4].opaqueState).toBe('OPAQUE_4');
    expect(bodies[4].input.results.map((event) => event.name)).toEqual(['story.read']);
  });

  test('a switch without any saved summary, or beside another call, is a recoverable denial', async () => {
    const saved = persistence();
    const log = hooks(saved.persist);
    const bodies = script([
      (_body, n) => toolTurn([{ id: 'c1', name: 'context.new', args: {} }], n),
      (_body, n) =>
        toolTurn(
          [
            { id: 'c2', name: 'context.new', args: { summary: workingSummary } },
            { id: 'c3', name: 'story.list', args: {} },
          ],
          n
        ),
      () => completed(),
    ]);
    const result = await runMain(snapshot(), log.value);
    expect(result.status).toBe('completed');
    expect(log.events.map((event) => [event.name, event.denied])).toEqual([
      ['context.new', true],
      ['context.new', true],
      ['story.list', false],
    ]);
    expect(log.events[0]).toMatchObject({
      result: { code: 'SUMMARY_REQUIRED' },
      errorKind: 'recoverable',
    });
    expect(log.events[1].result).toEqual({ code: 'CONTEXT_NEW_MUST_BE_ALONE' });
    expect(saved.calls).toEqual([]);
    expect(bodies[2].opaqueState).toBe('OPAQUE_2');
    expect(bodies[2].input.results).toHaveLength(3);
  });

  test('a failed durable save is reported, never treated as saved, and the run continues', async () => {
    const failing: ContextPersistence = () => {
      throw new Error('disk full');
    };
    const log = hooks(failing);
    script([
      (_body, n) =>
        toolTurn([{ id: 'c1', name: 'context.write', args: { summary: workingSummary } }], n),
      (_body, n) => toolTurn([{ id: 'c2', name: 'context.read', args: {} }], n),
      () => completed(),
    ]);
    const result = await runMain(snapshot(), log.value);
    expect(result.status).toBe('completed');
    expect(log.events[0]).toMatchObject({
      denied: true,
      result: { code: 'CONTEXT_WRITE_FAILED' },
      errorKind: 'recoverable',
    });
    expect(log.events[1].result).toMatchObject({
      savedSummary: null,
      windowSummary: null,
      compacted: [],
      retained: chapters.map((_, index) => `chapter-${index}`),
      checkpoint: null,
    });
  });

  test('presets without the flag, evaluation presets and artifacts never register the tools', async () => {
    const off = snapshot(false);
    expect(contextToolsEnabled(off)).toBe(false);
    const built = buildMainProviderRequest(off).request;
    expect(built.stable.tools.some((tool) => CONTEXT_TOOL_NAMES.includes(tool.name as never))).toBe(
      false
    );
    expect(built.stable.contract).not.toContain('Context window tools');
    expect(built.input.source).not.toHaveProperty('contextWindow');
    const evaluated = snapshot();
    evaluated.profile!.models.main!.evaluationTools = {
      contextMode: 'model-selected',
      approvalReasoningMode: 'configured',
      maximumToolRounds: 8,
      terminalLateCorrections: false,
      outputRecovery: true,
    };
    expect(contextToolsEnabled(evaluated)).toBe(false);
    expect(contextToolsEnabled({ ...snapshot(), executionPurpose: 'artifact' })).toBe(false);
    const log = hooks(persistence().persist);
    script([
      (_body, n) =>
        toolTurn([{ id: 'c1', name: 'context.write', args: { summary: workingSummary } }], n),
    ]);
    const result = await runMain(off, log.value);
    expect(result).toMatchObject({ status: 'error', error: 'READ_TOOL_DENIED' });
    expect(log.events[0].denied).toBe(true);
  });

  test('window usage levels follow the documented 70/80 percent thresholds', () => {
    expect(contextWindowStatus(1000, 10000)).toEqual({
      inputTokenLimit: 10000,
      estimatedInputTokens: 1000,
      usedRatio: 0.1,
      level: 'ok',
    });
    expect(contextWindowStatus(7000, 10000)).toMatchObject({ level: 'notice', usedRatio: 0.7 });
    expect(contextWindowStatus(7000, 10000).notice).toContain('context.new');
    expect(contextWindowStatus(8400, 10000)).toMatchObject({ level: 'urgent', usedRatio: 0.84 });
    expect(contextWindowStatus(8400, 10000).notice).toContain('85%');
  });

  test('the post-switch request is a valid fresh request for every native encoder', async () => {
    const fixed = snapshot();
    const outcome = await executeContextTool(
      fixed,
      { callId: 'switch', name: 'context.new', args: { keepRecent: 1, summary: workingSummary } },
      {
        state: { workingSummary: null, checkpoint: null },
        alone: true,
        pendingResults: 3,
        reservedBootstrap: 0,
        persist: persistence().persist,
      }
    );
    expect(outcome.switched).toBeDefined();
    const { request } = buildMainProviderRequest(outcome.switched!, {
      segmentBootstrap: [outcome.event],
    });
    expect(request.bootstrap).toHaveLength(1);
    expect(request.input.results).toEqual([]);
    expect(request).not.toHaveProperty('opaqueState');
    const responses = encodeResponses({ ...request, modelId: 'gpt-5.6' }).body as Record<
      string,
      any
    >;
    expect(JSON.stringify(responses.input)).toContain('context.new');
    expect(JSON.stringify(responses.input)).toContain(workingSummary);
    expect(JSON.stringify(responses.input)).not.toContain('CHAPTER_0_CANARY');
    const chat = encodeChat({ ...request, modelId: 'gpt-5.6' }).body as Record<string, any>;
    expect(JSON.stringify(chat.messages)).toContain(workingSummary);
    const anthropic = encodeAnthropic({ ...request, modelId: 'claude-opus-5' }).body as Record<
      string,
      any
    >;
    expect(anthropic.messages[0].content[0]).toMatchObject({
      type: 'tool_use',
      name: 'context.new',
    });
    expect(anthropic.messages[1].content[0]).toMatchObject({ type: 'tool_result' });
    const vertex = encodeVertex({ ...request, modelId: VERTEX_GEMINI_MODEL_ID }).body as Record<
      string,
      any
    >;
    expect(JSON.stringify(vertex.contents)).toContain(workingSummary);
  });
});
