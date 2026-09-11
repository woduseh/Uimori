import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { estimateContextTokens } from '../core/context-budget.js';
import {
  CONTEXT_CONTINUATION_GUIDANCE,
  CONTEXT_RETRIEVAL_GUIDANCE,
  CONTEXT_SUMMARY_SEMANTICS,
} from '../core/context-summary-policy.js';
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
import { buildMainProviderRequest, encodeMainPreview } from '../server/main-request.js';
import { runMain, type MainHooks } from '../server/model-runner.js';
import { compactToolReads } from '../server/context-tool-compaction.js';
import { executeTool } from '../core/provider.js';
import { createSourceSegmentFixture } from './fixtures/source-segments.js';

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
function oversizedSnapshot(): RunSnapshot {
  const fixed = snapshot();
  fixed.profile!.models.main!.inputTokenLimit = 8192;
  fixed.profile!.contextModel = {
    ...model(false),
    id: 'summary-model',
    modelId: 'fixture-summary',
    inputTokenLimit: 32768,
  };
  for (const source of fixed.history) {
    source.text = `${source.text}\n${'미라는 조건 하나와 별개의 약속을 구분한다. '.repeat(500)}`;
    source.contentHash = hash(source.text);
    for (const message of fixed.logicalHistory!.filter(
      (item) => item.sourceRevision === source.revision
    )) {
      message.sourceHash = source.contentHash;
      if (message.role === 'assistant') message.text = source.text;
    }
  }
  return withContextProjection(
    seedContextPlan(fixed),
    fixed.history.map((source) => ({ revision: source.revision, hash: source.contentHash! })),
    workingSummary
  );
}
/** Leave a measured 14% margin around fixed instructions, independent of tokenizer fixture drift. */
function fixedHeavySnapshot(vertex = false): RunSnapshot {
  const fixed = oversizedSnapshot(),
    target = fixed.profile!.models.main!,
    block = fixed.profile!.promptPresets!.main!.program.blocks[0];
  if (block.kind !== 'message') throw new Error('Expected a fixed instruction block');
  block.template = [
    {
      kind: 'text',
      text:
        'FIXED_INSTRUCTIONS_CANARY\n' + 'Keep every separate promise and condition. '.repeat(1800),
    },
  ];
  target.inputTokenLimit = 65536;
  fixed.profile!.contextModel!.inputTokenLimit = 65536;
  if (vertex) {
    target.modelId = VERTEX_GEMINI_MODEL_ID;
    target.connection = {
      ...target.connection,
      protocol: 'vertex-gemini-v1',
      endpoint:
        'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models',
      credentialEnv: 'NARRATIVE_PROVIDER_VERTEX_TEST',
    };
  }
  const project = () =>
    withContextProjection(
      seedContextPlan(fixed),
      fixed.history.map((source) => ({ revision: source.revision, hash: source.contentHash! })),
      workingSummary
    );
  target.inputTokenLimit = Math.ceil(measureMainContext(project()).estimatedInputTokens / 0.86);
  const measured = measureMainContext(project());
  return {
    ...measured.snapshot,
    contextPlan: {
      ...measured.snapshot.contextPlan!,
      estimatedInputTokens: measured.estimatedInputTokens,
    },
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
const projectedTokens = (fixed: RunSnapshot) => (events: ToolEvent[]) =>
  estimateContextTokens(
    encodeMainPreview(
      buildMainProviderRequest(fixed, { completedToolHistory: events }).request,
      fixed.profile!.models.main!
    ).body
  );
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
  test.each([
    {
      consumerLimit: 65536,
      summaryLimit: 8192,
      output: 8192,
      thinking: 7168,
      goal: 2048,
      budget: 2048,
    },
    {
      consumerLimit: 8192,
      summaryLimit: 32768,
      output: 1500,
      thinking: 1200,
      goal: 476,
      budget: 1024,
    },
  ])(
    'read compaction sends the $goal-token consumer goal with an independently sized $summaryLimit-token summarizer',
    async ({ consumerLimit, summaryLimit, output, thinking, goal, budget }) => {
      const fixed = snapshot();
      fixed.contextPlan!.budget.inputTokenLimit = consumerLimit;
      fixed.profile!.models.main!.inputTokenLimit = consumerLimit;
      fixed.profile!.contextModel = {
        ...model(false),
        id: 'summary-model',
        inputTokenLimit: summaryLimit,
        maxOutputTokens: output,
        thinkingBudgetTokens: thinking,
      };
      delete fixed.promptCompilation;
      const original = structuredClone(fixed),
        log = hooks(),
        event = executeTool(fixed, {
          callId: 'actual-read',
          name: 'story.read',
          args: { sceneNumber: 1, offset: 2, limit: 30 },
        });
      const bodies = script([
        (body) => {
          expect(body).toMatchObject({
            generation: { maxOutputTokens: Math.min(output, 4096), thinkingBudgetTokens: budget },
            stable: { contract: expect.stringContaining(CONTEXT_SUMMARY_SEMANTICS) },
            input: { controls: { targetSummaryTokens: goal }, task: fixed.request },
          });
          expect(JSON.parse(body.input.source.part as string)).toEqual([event]);
          expect(body.stable.contract).toContain(CONTEXT_RETRIEVAL_GUIDANCE);
          return completed();
        },
      ]);
      const events = await compactToolReads(
        fixed,
        [event],
        log.value,
        { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
        projectedTokens(fixed)
      );
      expect(bodies).toHaveLength(1);
      expect(events[0].result).toMatchObject({
        references: [
          {
            name: 'story.read',
            args: event.args,
            returned: {
              sceneNumber: 1,
              source: {
                revision: fixed.history[0].revision,
                hash: fixed.history[0].contentHash,
                start: 2,
                end: 32,
              },
              truncated: true,
              nextOffset: 32,
            },
          },
        ],
      });
      expect(goal + budget).toBeLessThanOrEqual(Math.min(output, 4096));
      expect(fixed).toEqual(original);
    }
  );

  test('read summaries retain returned revisions, filtered ranges and search excerpts without inventing full-source verification', async () => {
    const fixed = snapshot();
    fixed.profile!.contextModel = { ...model(false), inputTokenLimit: 32768 };
    fixed.sourceSegments = createSourceSegmentFixture({ excludeAnnotations: true });
    const source = fixed.history[0];
    source.text = 'VISIBLE_START <EvaluationReport>SECRET_NOTE</EvaluationReport> VISIBLE_END';
    source.contentHash = hash(source.text);
    for (const message of fixed.logicalHistory!.filter(
      (item) => item.sourceRevision === source.revision
    )) {
      message.sourceHash = source.contentHash;
      if (message.role === 'assistant') message.text = source.text;
    }
    fixed.resources = [
      {
        id: 'same-resource',
        chatId: fixed.chatId,
        kind: 'lore',
        revision: 1,
        title: 'Versioned source',
        description: 'A synthetic local source',
        text: 'OLD_RESOURCE_BODY',
      },
    ];
    delete fixed.promptCompilation;
    const revised = structuredClone(fixed);
    revised.resources[0] = { ...revised.resources[0], revision: 2, text: 'NEW_RESOURCE_BODY' };
    const originals = [structuredClone(fixed), structuredClone(revised)];
    const read = executeTool(fixed, {
      callId: 'filtered-read',
      name: 'story.read',
      args: { sceneNumber: 1, offset: 0, limit: 100 },
    });
    const search = executeTool(fixed, {
      callId: 'partial-search',
      name: 'story.search',
      args: { query: 'VISIBLE', offset: 0, limit: 20 },
    });
    const action = { name: 'knowledge.read', args: { id: 'same-resource', offset: 2, limit: 4 } };
    const firstVersion = executeTool(fixed, { ...action, callId: 'version-one' });
    const secondVersion = executeTool(revised, { ...action, callId: 'version-two' });
    const events = [read, search, firstVersion];
    expect(events.every((event) => !event.denied)).toBe(true);
    expect(secondVersion.denied).toBe(false);
    expect((read.result as { text: string }).text).not.toContain('SECRET_NOTE');
    const log = hooks();
    const bodies = script([() => completed(), () => completed()]);
    const usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const first = await compactToolReads(fixed, events, log.value, usage, projectedTokens(fixed));
    const second = await compactToolReads(
      revised,
      [...first, secondVersion],
      log.value,
      usage,
      projectedTokens(revised)
    );
    const result = second[0].result as {
      references: { name: string; args: Json; returned?: Record<string, Json> }[];
      guidance: string;
    };
    expect(result.references).toHaveLength(4);
    const metadata = result.references.find((item) => item.name === 'story.read')!.returned!;
    const originalRead = read.result as Record<string, Json>;
    expect(metadata).toMatchObject({
      source: originalRead.source,
      sceneScope: originalRead.sceneScope,
      keptRanges: originalRead.keptRanges,
      excludedRanges: originalRead.excludedRanges,
      rangeSemantics: originalRead.rangeSemantics,
    });
    expect(metadata).not.toHaveProperty('text');
    const searchMetadata = result.references.find((item) => item.name === 'story.search')!
      .returned!;
    const searchResults = (search.result as { results: Record<string, Json>[] }).results;
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchMetadata.results).toEqual(
      searchResults.map((item) => ({
        sceneNumber: item.sceneNumber,
        source: item.source,
        truncated: item.truncated,
        nextOffset: item.nextOffset,
      }))
    );
    const versions = result.references.filter((item) => item.name === 'knowledge.read');
    expect(versions.map((item) => item.args)).toEqual([firstVersion.args, secondVersion.args]);
    expect(versions.map((item) => item.returned!.source)).toEqual([
      (firstVersion.result as { source: Json }).source,
      (secondVersion.result as { source: Json }).source,
    ]);
    expect(
      versions.every(
        (item) =>
          JSON.stringify(item.returned!.range) ===
          JSON.stringify({ start: 2, end: 6, unit: 'utf16-code-unit' })
      )
    ).toBe(true);
    expect(result.guidance).toContain(CONTEXT_RETRIEVAL_GUIDANCE);
    expect(JSON.stringify(result)).not.toContain('SECRET_NOTE');
    expect(JSON.stringify(result)).not.toContain('OLD_RESOURCE_BODY');
    expect(JSON.stringify(result)).not.toContain('NEW_RESOURCE_BODY');
    expect(bodies[1].input.source.part).toContain('host-compacted-reads');
    expect([fixed, revised]).toEqual(originals);
  });

  test('summary headroom includes retained source metadata and exact receipts in the actual fresh body', async () => {
    const fixed = fixedHeavySnapshot(),
      log = hooks(persistence().persist),
      limit = measureMainContext(fixed).estimatedInputTokens + 2800;
    fixed.profile!.models.main!.inputTokenLimit = limit;
    fixed.contextPlan!.budget.inputTokenLimit = limit;
    delete fixed.promptCompilation;
    const original = structuredClone(fixed);
    const bodies = script([
      (_body, n) =>
        toolTurn(
          [
            { id: 'exact-write-receipt', name: 'context.write', args: { summary: workingSummary } },
            ...Array.from({ length: 6 }, (_, index) => ({
              id: `metadata-read-${index}`,
              name: 'story.read',
              args: { sceneNumber: 1, offset: index * 200, limit: 1200 },
            })),
          ],
          n
        ),
      () => completed(),
      () => completed(),
    ]);
    const result = await runMain(fixed, log.value);
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'completed',
      usage: { modelCalls: 3 },
    });
    expect(bodies.map((body) => body.role)).toEqual(['main', 'context', 'main']);
    const history = bodies[2].input.source.completedToolHistory as { events: ToolEvent[] };
    const receipt = log.events.find((event) => event.callId === 'exact-write-receipt')!;
    expect(receipt.denied).toBe(false);
    expect(history.events[0]).toEqual(receipt);
    expect(history.events).toHaveLength(2);
    const compacted = history.events[1].result as {
      summary: string;
      references: { name: string; args: Json; returned: Record<string, Json> }[];
    };
    expect(compacted.summary).toBe(finalText);
    expect(compacted.references).toHaveLength(6);
    for (const [index, reference] of compacted.references.entries())
      expect(reference).toMatchObject({
        name: 'story.read',
        args: { sceneNumber: 1, offset: index * 200, limit: 1200 },
        returned: {
          source: {
            revision: fixed.history[0].revision,
            hash: fixed.history[0].contentHash,
            start: index * 200,
            end: index * 200 + 1200,
          },
        },
      });
    const emptyBody = structuredClone(bodies[2]);
    const emptyHistory = emptyBody.input.source.completedToolHistory as { events: ToolEvent[] };
    (emptyHistory.events[1].result as { summary: string }).summary = '';
    const fixedTokens = estimateContextTokens(emptyBody);
    const goal = (bodies[1].input as unknown as { controls: { targetSummaryTokens: number } })
      .controls.targetSummaryTokens;
    // Metadata consumes real room that the previous non-read-only estimate omitted.
    expect(fixedTokens).toBeGreaterThan(projectedTokens(fixed)([receipt]));
    expect(limit - fixedTokens).toBeGreaterThan(0);
    expect(goal).toBeLessThanOrEqual(limit - fixedTokens);
    expect(goal).toBeLessThan(
      Math.min(2048, Math.floor(limit / 8), limit - projectedTokens(fixed)([receipt]))
    );
    expect(estimateContextTokens(bodies[2])).toBeLessThanOrEqual(limit);
    expect(log.events.find((event) => event.name === 'context.compact')!.result).toMatchObject({
      applied: true,
    });
    expect(bodies[2]).not.toHaveProperty('opaqueState');
    expect(bodies[2].prompt!.messages.at(-1)!.content[0].text).toContain('read-results-compacted');
    expect(fixed).toEqual(original);
  });

  test('a useful read summary proceeds above the soft trigger with less than ten percent total reduction', async () => {
    const fixed = fixedHeavySnapshot(),
      original = structuredClone(fixed),
      log = hooks(),
      limit = fixed.contextPlan!.budget.inputTokenLimit;
    const bodies = script([
      (_body, n) =>
        toolTurn(
          [{ id: 'small-useful-read', name: 'story.read', args: { sceneNumber: 1, limit: 1200 } }],
          n
        ),
      () => completed(),
      () => completed(),
    ]);
    const result = await runMain(fixed, log.value);
    expect(result).toMatchObject({
      status: 'completed',
      text: finalText,
      usage: { modelCalls: 3 },
    });
    expect(bodies.map((body) => body.role)).toEqual(['main', 'context', 'main']);
    const compacted = log.events.find((event) => event.name === 'context.compact')!.result as {
      applied: boolean;
      beforeTokens: number;
      afterTokens: number;
    };
    expect(compacted.applied).toBe(true);
    expect(compacted.beforeTokens).toBeGreaterThan(limit * 0.85);
    expect(compacted.afterTokens).toBeGreaterThan(limit * 0.85);
    expect(compacted.afterTokens).toBeGreaterThanOrEqual(compacted.beforeTokens * 0.9);
    expect(compacted.afterTokens).toBeLessThan(compacted.beforeTokens);
    expect(compacted.afterTokens).toBeLessThanOrEqual(limit);
    expect(bodies[2]).not.toHaveProperty('opaqueState');
    expect(bodies[2].input.results).toEqual([]);
    expect(bodies[2].input.source.completedToolHistory).toMatchObject({
      events: [
        {
          callId: 'small-useful-read',
          result: { kind: 'host-compacted-reads', summary: finalText },
        },
      ],
    });
    expect(fixed).toEqual(original);
  });

  test('an unhelpful summary keeps Vertex signed history; only a new successful read permits another summary', async () => {
    const fixed = fixedHeavySnapshot(true),
      target = fixed.profile!.models.main!,
      original = structuredClone(fixed),
      saved = persistence(),
      log = hooks(saved.persist),
      limit = fixed.contextPlan!.budget.inputTokenLimit;
    log.value.resolveCredential = () => 'SYNTHETIC_VERTEX_TOKEN';
    const vertexBodies: any[] = [],
      summaryBodies: Body[] = [],
      roles: string[] = [];
    const expandedSummary =
      'Expanded reading keeps each separate participant and condition. '.repeat(400);
    const reply = (parts: unknown[]) =>
      sse({
        candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 },
      });
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      const body = JSON.parse(String(options?.body));
      if (String(url).startsWith(origin)) {
        roles.push('context');
        summaryBodies.push(body);
        return sse(
          { type: 'text_delta', delta: expandedSummary },
          { type: 'usage', inputTokens: 11, outputTokens: 7, costUsd: null },
          { type: 'done', reason: 'stop' }
        );
      }
      roles.push('main');
      vertexBodies.push(body);
      if (vertexBodies.length === 1)
        return reply([
          {
            functionCall: {
              id: 'first-read',
              name: 'story.read',
              args: { sceneNumber: 1, limit: 40 },
            },
            thoughtSignature: 'ORIGINAL_READ_SIGNATURE',
          },
        ]);
      if (vertexBodies.length === 2)
        return reply([
          {
            functionCall: {
              id: 'write-between-reads',
              name: 'context.write',
              args: { summary: workingSummary },
            },
            thoughtSignature: 'WRITE_SIGNATURE',
          },
        ]);
      if (vertexBodies.length === 3)
        return reply([
          {
            functionCall: {
              id: 'second-read',
              name: 'story.read',
              args: { sceneNumber: 2, limit: 40 },
            },
            thoughtSignature: 'SECOND_READ_SIGNATURE',
          },
        ]);
      return reply([{ text: finalText }]);
    });
    const result = await runMain(fixed, log.value);
    expect(result).toMatchObject({
      status: 'completed',
      text: finalText,
      usage: { modelCalls: 6 },
    });
    expect(roles).toEqual(['main', 'context', 'main', 'main', 'context', 'main']);
    expect(vertexBodies).toHaveLength(4);
    expect(summaryBodies).toHaveLength(2);
    expect(saved.calls).toHaveLength(1);
    expect(log.events.filter((event) => event.name === 'context.write')).toHaveLength(1);
    expect(summaryBodies[0].input.source.part).toContain('first-read');
    expect(summaryBodies[1].input.source.part).toContain('second-read');
    for (const body of summaryBodies)
      expect(body.input.source.part).not.toContain('write-between-reads');
    const compactions = log.events
      .filter((event) => event.name === 'context.compact')
      .map(
        (event) => event.result as { applied: boolean; beforeTokens: number; afterTokens: number }
      );
    expect(compactions).toHaveLength(2);
    for (const event of compactions) {
      expect(event.applied).toBe(false);
      expect(event.beforeTokens).toBeGreaterThan(limit * 0.85);
      expect(event.beforeTokens).toBeLessThanOrEqual(limit);
      expect(event.afterTokens).toBeGreaterThanOrEqual(event.beforeTokens);
    }
    const responses = (body: any) =>
      body.contents
        .flatMap((content: any) => content.parts)
        .flatMap((part: any) => (part.functionResponse ? [part.functionResponse] : []));
    const firstResponse = responses(vertexBodies[1]).find((part: any) => part.id === 'first-read');
    expect(firstResponse).toMatchObject({
      name: 'story.read',
      response: { text: expect.any(String), contextWindow: { inputTokenLimit: limit } },
    });
    for (const body of vertexBodies.slice(1)) {
      expect(JSON.stringify(body)).toContain('ORIGINAL_READ_SIGNATURE');
      expect(JSON.stringify(body)).not.toContain('host-completed-tool-history');
      expect(JSON.stringify(body)).not.toContain('skip_thought_signature_validator');
      expect(responses(body).find((part: any) => part.id === 'first-read')).toEqual(firstResponse);
      expect(estimateContextTokens(body)).toBeLessThanOrEqual(limit);
    }
    expect(JSON.stringify(vertexBodies[2])).toContain('WRITE_SIGNATURE');
    expect(JSON.stringify(vertexBodies[3])).toContain('SECOND_READ_SIGNATURE');
    expect(
      responses(vertexBodies[3]).filter((part: any) => part.name === 'context.write')
    ).toHaveLength(1);
    expect(target.connection.protocol).toBe('vertex-gemini-v1');
    expect(fixed).toEqual(original);
  });

  test('when original reads and their summary both exceed the hard limit no further main request is sent', async () => {
    const fixed = fixedHeavySnapshot(),
      log = hooks(),
      original = structuredClone(fixed),
      limit = fixed.contextPlan!.budget.inputTokenLimit;
    const bodies = script([
      (_body, n) =>
        toolTurn(
          Array.from({ length: 4 }, (_, index) => ({
            id: `over-limit-read-${index}`,
            name: 'story.read',
            args: { sceneNumber: index + 1, limit: 16000 },
          })),
          n
        ),
      () =>
        sse(
          {
            type: 'text_delta',
            delta: 'Expanded reading keeps each separate participant and condition. '.repeat(400),
          },
          { type: 'usage', inputTokens: 11, outputTokens: 7, costUsd: null },
          { type: 'done', reason: 'stop' }
        ),
    ]);
    const result = await runMain(fixed, log.value);
    expect(result).toMatchObject({
      status: 'error',
      error: 'CONTEXT_TOOL_COMPACTION_NO_PROGRESS',
      usage: { modelCalls: 2 },
    });
    expect(bodies.map((body) => body.role)).toEqual(['main', 'context']);
    expect(log.events.filter((event) => event.name === 'story.read')).toHaveLength(4);
    const compacted = log.events.find((event) => event.name === 'context.compact')!.result as {
      applied: boolean;
      beforeTokens: number;
      afterTokens: number;
    };
    expect(compacted.applied).toBe(false);
    expect(compacted.beforeTokens).toBeGreaterThan(limit);
    expect(compacted.afterTokens).toBeGreaterThan(limit);
    expect(fixed).toEqual(original);
  });

  test.each(['completed', 'eof', 'call-limit', 'authorization-revoked'] as const)(
    'accumulated reads are admitted before the next send; compaction %s preserves saved effects and originals',
    async (outcome) => {
      const fixed = oversizedSnapshot();
      fixed.settings.maxCalls = outcome === 'call-limit' ? 3 : 8;
      const original = structuredClone(fixed);
      const saved = persistence(),
        log = hooks(saved.persist);
      let revoked = false;
      log.value.authorize = (connection) => ({ ...connection, enabled: !revoked });
      const bodies = script([
        (_body, n) =>
          toolTurn(
            [{ id: 'saved-once', name: 'context.write', args: { summary: workingSummary } }],
            n
          ),
        (_body, n) =>
          toolTurn(
            Array.from({ length: 4 }, (_, i) => ({
              id: `large-read-${i}`,
              name: 'story.read',
              args: { sceneNumber: i + 1, limit: 16000 },
            })),
            n
          ),
        (body) => {
          expect(body.role).toBe('context');
          expect(body.input.source.part).toContain('large-read-0');
          expect(body.input.source.part).not.toContain('saved-once');
          revoked = outcome === 'authorization-revoked';
          return outcome === 'eof' ? sse({ type: 'text_delta', delta: 'Incomplete' }) : completed();
        },
        (body) => {
          expect(body.role).toBe('main');
          expect(body).not.toHaveProperty('opaqueState');
          expect(body.input.results).toEqual([]);
          expect(body).not.toHaveProperty('bootstrap');
          const history = body.input.source.completedToolHistory as { events: ToolEvent[] };
          expect(history.events).toHaveLength(2);
          expect(history.events[0]).toMatchObject({
            callId: 'saved-once',
            name: 'context.write',
            result: { saved: true, checkpoint: { id: 'cp-1' } },
          });
          expect(history.events[1]).toMatchObject({
            name: 'story.read',
            result: {
              kind: 'host-compacted-reads',
              summary: finalText,
              references: Array.from({ length: 4 }, (_, i) => ({
                name: 'story.read',
                args: { sceneNumber: i + 1, limit: 16000 },
              })),
            },
          });
          return completed();
        },
      ]);
      const result = await runMain(fixed, log.value);
      expect(fixed).toEqual(original);
      expect(saved.calls).toHaveLength(1);
      expect(log.events.filter((event) => event.name === 'story.read')).toHaveLength(4);
      expect(
        log.events.find((event) => event.callId === 'large-read-3')!.result
      ).not.toHaveProperty('contextWindow');
      if (outcome === 'completed') {
        expect(result).toMatchObject({ status: 'completed', usage: { modelCalls: 4 } });
        expect(log.events.at(-1)).toMatchObject({ name: 'context.compact' });
        expect(
          (log.events.at(-1)!.result as { beforeTokens: number }).beforeTokens
        ).toBeGreaterThan(8192);
        expect(bodies).toHaveLength(4);
      } else {
        expect(result).toMatchObject({
          status: 'error',
          error:
            outcome === 'eof'
              ? 'CONTEXT_TOOL_COMPACTION_EOF'
              : outcome === 'authorization-revoked'
                ? 'CONNECTION_NOT_AUTHORIZED'
                : 'CONTEXT_TOOL_COMPACTION_CALL_LIMIT',
        });
        expect(bodies).toHaveLength(outcome === 'call-limit' ? 2 : 3);
        expect(log.events.some((event) => event.name === 'context.compact')).toBe(
          outcome === 'authorization-revoked'
        );
      }
    }
  );

  test.each(['single', 'batch', 'mixed'] as const)(
    'Vertex signed %s continuation becomes a fresh text reference after compaction, then resumes native reads',
    async (mode) => {
      const fixed = oversizedSnapshot(),
        target = fixed.profile!.models.main!,
        saved = persistence(),
        log = hooks(saved.persist);
      target.modelId = VERTEX_GEMINI_MODEL_ID;
      target.connection = {
        ...target.connection,
        protocol: 'vertex-gemini-v1',
        endpoint:
          'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models',
        credentialEnv: 'NARRATIVE_PROVIDER_VERTEX_TEST',
      };
      const original = structuredClone(fixed);
      log.value.resolveCredential = () => 'SYNTHETIC_VERTEX_TOKEN';
      log.value.persistContext = (prepared, own) => {
        if (mode === 'mixed' && saved.calls.length > 0)
          expect(log.events.at(-1)!.callId).toBe(
            saved.calls.length === 1 ? 'vertex-large-read' : 'fresh-read'
          );
        return saved.persist(prepared, own);
      };
      const vertexBodies: any[] = [],
        summaryBodies: Body[] = [];
      const reply = (parts: unknown[]) =>
        sse({
          candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 },
        });
      const readParts = (prefix: string, limit: number, signature: string) => [
        {
          functionCall: {
            id: `${prefix}-read`,
            name: 'story.read',
            args: { sceneNumber: 1, limit },
          },
          thoughtSignature: signature,
        },
        ...(mode === 'mixed'
          ? [
              {
                functionCall: {
                  id: `${prefix}-write`,
                  name: 'context.write',
                  args: { summary: workingSummary },
                },
              },
            ]
          : []),
        ...(mode !== 'single'
          ? [
              {
                functionCall: {
                  id: `${prefix}-read-2`,
                  name: 'story.read',
                  args: { sceneNumber: 2, limit },
                },
              },
            ]
          : []),
      ];
      vi.mocked(fetch).mockImplementation(async (url, options) => {
        const body = JSON.parse(String(options?.body));
        if (String(url).startsWith(origin)) {
          summaryBodies.push(body);
          expect(body.role).toBe('context');
          expect(body.input.source.part).toContain('vertex-large-read');
          expect(body.input.source.part).not.toContain('vertex-write');
          return completed();
        }
        expect(String(url)).toBe(
          `${target.connection.endpoint}/${target.modelId}:streamGenerateContent?alt=sse`
        );
        vertexBodies.push(body);
        if (vertexBodies.length === 1)
          return reply([
            {
              functionCall: {
                id: 'vertex-write',
                name: 'context.write',
                args: { summary: workingSummary },
              },
              thoughtSignature: 'OLD_SIGNED_WRITE',
            },
          ]);
        if (vertexBodies.length === 2) {
          expect(JSON.stringify(body.contents)).toContain('OLD_SIGNED_WRITE');
          return reply(readParts('vertex-large', 16000, 'OLD_SIGNED_READ'));
        }
        const text = JSON.stringify(body);
        expect(text).toContain('host-completed-tool-history');
        expect(text).toContain('vertex-write');
        expect(text).toContain('host-compacted-reads');
        expect(text).not.toContain('OLD_SIGNED_WRITE');
        expect(text).not.toContain('OLD_SIGNED_READ');
        expect(text).not.toContain('skip_thought_signature_validator');
        if (vertexBodies.length === 3) {
          expect(
            body.contents.every((message: any) =>
              message.parts.every((part: any) => !part.functionCall && !part.functionResponse)
            )
          ).toBe(true);
          return reply(readParts('fresh', 40, 'NEW_SIGNED_READ'));
        }
        expect(vertexBodies).toHaveLength(4);
        expect(text).toContain('NEW_SIGNED_READ');
        expect(body.contents.at(-1).parts[0].functionResponse).toMatchObject({
          id: 'fresh-read',
          name: 'story.read',
        });
        expect(body.contents.at(-1).parts).toHaveLength(
          mode === 'single' ? 1 : mode === 'batch' ? 2 : 3
        );
        const windows = body.contents
          .at(-1)
          .parts.map((part: any) => part.functionResponse.response.contextWindow);
        expect(
          windows.every((window: any) => window.estimatedInputTokens >= estimateContextTokens(body))
        ).toBe(true);
        expect(
          windows.every((window: any) => JSON.stringify(window) === JSON.stringify(windows[0]))
        ).toBe(true);
        return reply([{ text: finalText }]);
      });
      const result = await runMain(fixed, log.value);
      expect(result).toMatchObject({
        status: 'completed',
        text: finalText,
        usage: { modelCalls: 5 },
      });
      expect(summaryBodies).toHaveLength(1);
      expect(vertexBodies).toHaveLength(4);
      expect(saved.calls).toHaveLength(mode === 'mixed' ? 3 : 1);
      expect(log.events.filter((event) => event.name === 'story.read')).toHaveLength(
        mode === 'single' ? 2 : 4
      );
      expect(
        log.events
          .filter((event) => event.name === 'context.write')
          .every((event) => !Object.hasOwn(event.result as object, 'contextWindow'))
      ).toBe(true);
      expect(fixed).toEqual(original);
    }
  );

  test('repeated compaction retains more than eight exact receipts and prior read arguments as one reference envelope', async () => {
    const fixed = oversizedSnapshot(),
      saved = persistence(),
      log = hooks(saved.persist);
    // This case isolates repeated receipt/continuation preservation from summary chunking.
    fixed.profile!.contextModel!.inputTokenLimit = 65536;
    const original = structuredClone(fixed);
    const largeReads = (prefix: string, offset: number) =>
      Array.from({ length: 4 }, (_, i) => ({
        id: `${prefix}-${i}`,
        name: 'story.read',
        args: { sceneNumber: i + 1, offset, limit: 16000 },
      }));
    const receipts = () => log.events.filter((event) => event.name === 'context.write');
    const bodies = script([
      (_body, n) =>
        toolTurn(
          Array.from({ length: 9 }, (_, i) => ({
            id: `write-${i}`,
            name: 'context.write',
            args: { summary: `Saved ${i}` },
          })),
          n
        ),
      (_body, n) => toolTurn(largeReads('first-read', 0), n),
      () => completed(),
      (body, n) => {
        expect(body.input.results).toEqual([]);
        expect(body).not.toHaveProperty('bootstrap');
        expect(body).not.toHaveProperty('opaqueState');
        const history = body.input.source.completedToolHistory as { events: ToolEvent[] };
        expect(history.events.filter((event) => event.name === 'context.write')).toEqual(
          receipts()
        );
        return toolTurn(largeReads('second-read', 1), n);
      },
      (body) => {
        expect(body.input.source.part).toContain('host-compacted-reads');
        expect(body.input.source.part).toContain('second-read-0');
        expect(body.input.source.part).not.toContain('write-0');
        return completed();
      },
      (body) => {
        expect(body.input.results).toEqual([]);
        expect(body).not.toHaveProperty('bootstrap');
        expect(body).not.toHaveProperty('opaqueState');
        const history = body.input.source.completedToolHistory as { events: ToolEvent[] };
        expect(history.events).toHaveLength(10);
        expect(history.events.filter((event) => event.name === 'context.write')).toEqual(
          receipts()
        );
        expect(history.events.at(-1)!.result).toMatchObject({
          references: [...largeReads('ignored', 0), ...largeReads('ignored', 1)].map(
            ({ name, args }) => ({ name, args })
          ),
        });
        const references = (
          history.events.at(-1)!.result as {
            references: { returned: { source: Json; sceneScope: Json } }[];
          }
        ).references;
        const reads = log.events.filter((event) => event.name === 'story.read');
        expect(references.map((reference) => reference.returned.source)).toEqual(
          reads.map((event) => (event.result as { source: Json }).source)
        );
        expect(references.map((reference) => reference.returned.sceneScope)).toEqual(
          reads.map((event) => (event.result as { sceneScope: Json }).sceneScope)
        );
        for (const [protocol, modelId] of [
          ['vertex-gemini-v1', VERTEX_GEMINI_MODEL_ID],
          ['openai-responses-v1', 'gpt-5.6'],
          ['openai-chat-v1', 'gpt-5.6'],
          ['anthropic-messages-v1', 'claude-sonnet-4-6'],
        ] as const) {
          const target = structuredClone(fixed);
          target.profile!.models.main!.connection.protocol = protocol;
          target.profile!.models.main!.modelId = modelId;
          const request = buildMainProviderRequest(target, {
            completedToolHistory: history.events,
          }).request;
          const encoded =
            protocol === 'vertex-gemini-v1'
              ? encodeVertex(request).body
              : protocol === 'openai-responses-v1'
                ? encodeResponses(request).body
                : protocol === 'anthropic-messages-v1'
                  ? encodeAnthropic(request).body
                  : encodeChat(request).body;
          const text = JSON.stringify(encoded);
          expect(text).toContain('host-completed-tool-history');
          expect(text).toContain('write-8');
          expect(text).toContain('host-compacted-reads');
          expect(request.input.results).toEqual([]);
          expect(request).not.toHaveProperty('bootstrap');
        }
        // A completed call ID cannot replay a mutation after either reset.
        return toolTurn([{ id: 'write-0', name: 'context.write', args: { summary: 'Replay' } }], 6);
      },
    ]);
    const result = await runMain(fixed, log.value);
    expect(bodies.map((body) => body.role)).toEqual([
      'main',
      'main',
      'context',
      'main',
      'context',
      'main',
    ]);
    expect(result).toMatchObject({
      status: 'error',
      error: 'DUPLICATE_TOOL_ID',
      usage: { modelCalls: 6 },
    });
    expect(bodies).toHaveLength(6);
    expect(saved.calls).toHaveLength(9);
    expect(log.events.filter((event) => event.name === 'context.compact')).toHaveLength(2);
    expect(fixed).toEqual(original);
  });

  test('list, write, switch alone, then read a compacted original through the new window', async () => {
    const saved = persistence();
    const log = hooks(saved.persist);
    const bodies = script([
      (_body, n) => toolTurn([{ id: 'c1', name: 'story.list', args: {} }], n),
      (_body, n) =>
        toolTurn([{ id: 'c2', name: 'context.write', args: { summary: workingSummary } }], n),
      (_body, n) => toolTurn([{ id: 'c3', name: 'context.new', args: { keepRecent: 2 } }], n),
      (_body, n) =>
        toolTurn([{ id: 'c4', name: 'story.read', args: { sceneNumber: 1, limit: 40 } }], n),
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
    expect(first.stable.contract).toContain(CONTEXT_SUMMARY_SEMANTICS);
    expect(first.stable.contract).toContain(CONTEXT_RETRIEVAL_GUIDANCE);
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
    expect(log.events[0].result).not.toHaveProperty('contextWindow');
    const listed = bodies[1].input.results[0].result as {
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
    });
    expect(log.events[1].result).not.toHaveProperty('contextWindow');
    expect(bodies[2].input.results[1].result).toMatchObject({
      contextWindow: { inputTokenLimit: 16384 },
    });
    expect(saved.calls[0]).toEqual({ compacted: 0, summary: workingSummary, own: null });
    expect(log.events[2].result).toMatchObject({
      switched: true,
      compactedExchanges: 3,
      retained: [
        { sceneNumber: 4, revision: 'chapter-3', hash: hash(chapters[3]) },
        { sceneNumber: 5, revision: 'chapter-4', hash: hash(chapters[4]) },
      ],
      sceneScope: {
        chatId: snapshot().chatId,
        headRevision: 'chapter-4',
        headHash: hash(chapters[4]),
      },
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
    expect(reread).toMatchObject({
      sceneNumber: 1,
      sceneScope: { headRevision: 'chapter-4', headHash: hash(chapters[4]) },
    });
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
      retained: chapters.map((text, index) => ({
        sceneNumber: index + 1,
        revision: `chapter-${index}`,
        hash: hash(text),
      })),
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
    const readBack = await executeContextTool(
      outcome.switched!,
      { callId: 'read-back', name: 'context.read', args: {} },
      {
        state: { workingSummary, checkpoint: null },
        alone: true,
        pendingResults: 0,
        reservedBootstrap: 0,
      }
    );
    expect(readBack.event).toMatchObject({
      denied: false,
      result: {
        savedSummary: workingSummary,
        windowSummary: workingSummary,
        sceneScope: {
          chatId: fixed.chatId,
          headRevision: 'chapter-4',
          headHash: hash(chapters[4]),
        },
        compacted: chapters.slice(0, 4).map((text, index) => ({
          sceneNumber: index + 1,
          revision: `chapter-${index}`,
          hash: hash(text),
        })),
        retained: [{ sceneNumber: 5, revision: 'chapter-4', hash: hash(chapters[4]) }],
      },
    });
    const preservedSnapshot = structuredClone(outcome.switched!);
    const initial = buildMainProviderRequest(outcome.switched!).request;
    expect(initial.input.source).not.toHaveProperty('requestContinuation');
    const { request } = buildMainProviderRequest(outcome.switched!, {
      segmentBootstrap: [outcome.event],
    });
    expect(request.prompt!.messages.slice(0, -1)).toEqual(initial.prompt!.messages);
    expect(request.prompt!.messages.at(-1)).toMatchObject({
      id: 'native.request-continuation',
      role: 'user',
      content: [{ type: 'text', text: expect.stringContaining(CONTEXT_CONTINUATION_GUIDANCE) }],
    });
    const notice = request.prompt!.messages.at(-1)!.content[0].text;
    expect(notice).toContain('same-request-in-progress');
    expect(notice).toContain('context-window-opened');
    expect(notice).toContain('"callId":"switch","name":"context.new","denied":false');
    expect(request.input.source).not.toHaveProperty('requestContinuation');
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
    for (const messages of [responses.input, chat.messages, anthropic.messages, vertex.contents]) {
      const encoded = JSON.stringify(messages);
      // A completed step must remain after the original request in every fresh native window.
      // Otherwise the original sequence can look like a newly issued request again.
      expect(encoded.lastIndexOf('Host continuation for this in-flight request')).toBeGreaterThan(
        encoded.lastIndexOf('CURRENT_REQUEST_CANARY')
      );
      expect(encoded.lastIndexOf('CURRENT_REQUEST_CANARY')).toBeGreaterThan(-1);
    }
    expect(outcome.switched).toEqual(preservedSnapshot);
  });
});
