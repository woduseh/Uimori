import { VERTEX_GEMINI_MODEL_ID } from './fixtures/vertex-model.js';
import { refreshNativeSnapshot } from './fixtures/native-snapshot.js';
import { prepareNativeRisuRun } from '../server/risu-native-run.js';
import { nativePrompt } from './fixtures/native-prompt.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { estimateContextTokens } from '../core/context-budget.js';
import {
  CONTEXT_RETRIEVAL_GUIDANCE,
  CONTEXT_SUMMARY_SEMANTICS,
} from '../core/context-summary-policy.js';
import { defaultProfile, type ModelSnapshot } from '../core/product.js';
import type { RunSnapshot, ToolEvent } from '../core/types.js';
import type { Json } from '../core/transport.js';
import { encodeResponses } from '../core/openai-protocol.js';
import { buildCodexTurn } from '../core/codex-protocol.js';
import { encodeChat } from '../core/openai-chat-protocol.js';
import { encodeAnthropic } from '../core/anthropic-protocol.js';
import { encodeVertex } from '../core/vertex-protocol.js';
import {
  measureMainContext,
  seedContextPlan,
  withContextProjection,
} from '../server/context-planning.js';
import { buildMainProviderRequest, encodeMainPreview } from '../server/main-request.js';
import { runMain, type MainHooks } from '../server/model-runner.js';
import { compactToolReads } from '../server/context-tool-compaction.js';
import { executeTool } from '../core/provider.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const origin = 'http://127.0.0.1:44998';
const chapters = Array.from({ length: 5 }, (_, index) =>
  `CHAPTER_${index}_CANARY 미라는 항구에서 약속 ${index}을 기억해요.\n`.repeat(4)
);
const workingSummary =
  'WORKING_SUMMARY_CANARY: 미라와 선장의 관계는 3장에서 화해로 정리했고, 등불 약속은 아직 미해결이에요.';
const finalText = '미라는 등불을 들고 부두 끝으로 걸어갔어요.';
const model = (): ModelSnapshot => ({
  id: 'main-model',
  revision: 1,
  title: 'main-model',
  modelId: 'fixture-main',
  connectionId: 'connection-main',
  inputTokenLimit: 16384,
  maxOutputTokens: 4096,
  temperature: null,
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
async function snapshot(): Promise<RunSnapshot> {
  const target = model();
  const history = chapters.map((text, index) => ({
    revision: `chapter-${index}`,
    text,
    contentHash: hash(text),
  }));
  const seeded = seedContextPlan(
    await prepareNativeRisuRun({
      chatId: 'synthetic-context-tools-chat',
      parentRevision: history.at(-1)!.revision,
      settingsRevision: 1,
      settings: { maxCalls: 8 },
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
        models: { main: target },
        routes: { main: { id: target.id }, translation: null },
        promptPresets: {
          main: {
            id: 'synthetic-prompt',
            revision: 1,
            title: 'Synthetic prompt',
            role: 'main',
            program: nativePrompt('FIXED_INSTRUCTIONS_CANARY', {
              promptTemplate: [
                { type: 'plain', role: 'system', text: 'FIXED_INSTRUCTIONS_CANARY' },
                { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
              ],
            }),
          },
        },
      },
    })
  );
  const ready = withContextProjection(seeded, [], null);
  const measured = measureMainContext(ready);
  return {
    ...measured.snapshot,
    contextPlan: { ...ready.contextPlan!, estimatedInputTokens: measured.estimatedInputTokens },
  };
}
async function oversizedSnapshot(): Promise<RunSnapshot> {
  const fixed = await snapshot();
  fixed.profile!.models.main!.inputTokenLimit = 8192;
  fixed.profile!.contextModel = {
    ...model(),
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
async function fixedHeavySnapshot(vertex = false): Promise<RunSnapshot> {
  const fixed = await oversizedSnapshot(),
    target = fixed.profile!.models.main!,
    block = (
      fixed.profile!.promptPresets!.main!.program.nativeRisuPreset.preset.promptTemplate as Record<
        string,
        unknown
      >[]
    )[0];
  block.text =
    'FIXED_INSTRUCTIONS_CANARY\n' + 'Keep every separate promise and condition. '.repeat(1800);
  target.inputTokenLimit = 65536;
  fixed.profile!.contextModel!.inputTokenLimit = 65536;
  if (vertex) {
    target.modelId = VERTEX_GEMINI_MODEL_ID;
    target.connection = {
      ...target.connection,
      protocol: 'vertex-gemini-v1',
      endpoint:
        'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models',
      credentialRef: 'UIMORI_PROVIDER_VERTEX_TEST',
    };
  }
  await refreshNativeSnapshot(fixed);
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
const projectedTokens = (fixed: RunSnapshot) => (events: ToolEvent[]) =>
  estimateContextTokens(
    encodeMainPreview(
      buildMainProviderRequest(fixed, { completedToolHistory: events }).request,
      fixed.profile!.models.main!
    ).body
  );
function hooks() {
  const events: ToolEvent[] = [];
  const value: MainHooks = {
    signal: new AbortController().signal,

    authorize: (connection) => connection,
    onInput: () => {},
    onToolEvent: (event) => {
      events.push(event);
    },
    onAttemptStart: () => 'attempt',
    onAttemptFinish: () => {},
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

describe('host read compaction and provider continuation inside one main run', () => {
  test.each([
    {
      consumerLimit: 65536,
      summaryLimit: 8192,
      output: 8192,
      goal: 2048,
    },
    {
      consumerLimit: 8192,
      summaryLimit: 32768,
      output: 1500,
      goal: 750,
    },
  ])(
    'read compaction sends the $goal-token consumer goal with an independently sized $summaryLimit-token summarizer',
    async ({ consumerLimit, summaryLimit, output, goal }) => {
      const fixed = await snapshot();
      fixed.contextPlan!.budget.inputTokenLimit = consumerLimit;
      fixed.profile!.models.main!.inputTokenLimit = consumerLimit;
      fixed.profile!.contextModel = {
        ...model(),
        id: 'summary-model',
        inputTokenLimit: summaryLimit,
        maxOutputTokens: output,
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
            generation: { maxOutputTokens: Math.min(output, 4096) },
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
              nextOffset: 32,
            },
          },
        ],
      });
      expect(goal).toBeLessThanOrEqual(Math.min(output, 4096));
      expect(fixed).toEqual(original);
    }
  );

  test('oversized reads keep every fragment and Unicode boundary when the whole input does not fit', async () => {
    const fixed = await snapshot(),
      log = hooks();
    fixed.profile!.contextModel = { ...model(), inputTokenLimit: 8192 };
    const original = structuredClone(fixed),
      event: ToolEvent = {
        callId: 'large-unicode-read',
        name: 'story.read',
        args: { sceneNumber: 1 },
        denied: false,
        result: { text: '미라는 등불 🏮 약속을 기억한다.\n'.repeat(900) },
      },
      usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      bodies = script(
        Array.from({ length: 7 }, () => (body: Body) => {
          expect(estimateContextTokens(body)).toBeLessThanOrEqual(8192 * 0.8);
          return completed();
        })
      );
    const events = await compactToolReads(fixed, [event], log.value, usage, projectedTokens(fixed));
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.map((body) => body.input.source.part).join('')).toBe(JSON.stringify([event]));
    for (const [index, body] of bodies.entries()) {
      const part = body.input.source.part as string;
      expect(/[\uD800-\uDBFF]$/u.test(part)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/u.test(part)).toBe(false);
      expect(body.input.source.previousSummary).toBe(index === 0 ? '' : finalText);
    }
    expect(usage.modelCalls).toBe(bodies.length);
    expect(events[0].result).toMatchObject({ summary: finalText });
    expect(fixed).toEqual(original);
  });

  test('summary headroom includes retained source metadata and exact historical receipts in the actual fresh body', async () => {
    const fixed = await fixedHeavySnapshot(),
      log = hooks(),
      limit = measureMainContext(fixed).estimatedInputTokens + 4200;
    fixed.profile!.models.main!.inputTokenLimit = limit;
    fixed.contextPlan!.budget.inputTokenLimit = limit;
    delete fixed.promptCompilation;
    const original = structuredClone(fixed);
    // A previously completed mutation is data here, never an executable main tool.
    const receipt: ToolEvent = {
      callId: 'exact-write-receipt',
      name: 'context.write',
      args: { summary: workingSummary },
      result: { saved: true, checkpoint: { id: 'historical-checkpoint' } },
      denied: false,
    };
    const reads = Array.from({ length: 6 }, (_, index) =>
      executeTool(fixed, {
        callId: `metadata-read-${index}`,
        name: 'story.read',
        args: { sceneNumber: 1, offset: index * 200, limit: 1200 },
      })
    );
    const bodies = script([() => completed()]);
    const events = await compactToolReads(
      fixed,
      [receipt, ...reads],
      log.value,
      { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      projectedTokens(fixed)
    );
    expect(bodies.map((body) => body.role)).toEqual(['context']);
    expect(bodies[0].input.source.part).not.toContain(receipt.callId);
    expect(events[0]).toEqual(receipt);
    expect(events).toHaveLength(2);
    const compacted = events[1].result as {
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
    const emptyEvents = structuredClone(events);
    (emptyEvents[1].result as { summary: string }).summary = '';
    const fixedTokens = projectedTokens(fixed)(emptyEvents);
    const goal = (bodies[0].input as unknown as { controls: { targetSummaryTokens: number } })
      .controls.targetSummaryTokens;
    expect(fixedTokens).toBeGreaterThan(projectedTokens(fixed)([receipt]));
    expect(limit - fixedTokens).toBeGreaterThan(0);
    expect(goal).toBeLessThanOrEqual(limit - fixedTokens);
    expect(goal).toBeLessThan(
      Math.min(2048, Math.floor(limit / 8), limit - projectedTokens(fixed)([receipt]))
    );
    const fresh = encodeMainPreview(
      buildMainProviderRequest(fixed, { completedToolHistory: events }).request,
      fixed.profile!.models.main!
    ).body as unknown as Body;
    expect(estimateContextTokens(fresh)).toBeLessThanOrEqual(limit);
    expect(fresh).not.toHaveProperty('opaqueState');
    expect(fresh.prompt!.messages.at(-1)!.content[0].text).toContain('read-results-compacted');
    expect(fixed).toEqual(original);
  });

  test('a useful read summary proceeds above the soft trigger with less than ten percent total reduction', async () => {
    const fixed = await fixedHeavySnapshot(),
      original = structuredClone(fixed),
      log = hooks(),
      limit = fixed.contextPlan!.budget.inputTokenLimit;
    const bodies = script([
      (_body, n) =>
        toolTurn(
          [{ id: 'small-useful-read', name: 'story.read', args: { sceneNumber: 1, limit: 2400 } }],
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
    const fixed = await fixedHeavySnapshot(true),
      target = fixed.profile!.models.main!,
      original = structuredClone(fixed),
      log = hooks(),
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
              id: 'denied-between-reads',
              name: 'story.read',
              args: { sceneNumber: 999999 },
            },
            thoughtSignature: 'DENIED_READ_SIGNATURE',
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
    expect(log.events.find((event) => event.callId === 'denied-between-reads')).toMatchObject({
      denied: true,
      errorKind: 'recoverable',
    });
    expect(summaryBodies[0].input.source.part).toContain('first-read');
    expect(summaryBodies[1].input.source.part).toContain('second-read');
    for (const body of summaryBodies)
      expect(body.input.source.part).not.toContain('denied-between-reads');
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
      response: { text: expect.any(String) },
    });
    for (const body of vertexBodies.slice(1)) {
      expect(JSON.stringify(body)).toContain('ORIGINAL_READ_SIGNATURE');
      expect(JSON.stringify(body)).not.toContain('host-completed-tool-history');
      expect(JSON.stringify(body)).not.toContain('skip_thought_signature_validator');
      expect(responses(body).find((part: any) => part.id === 'first-read')).toEqual(firstResponse);
      expect(estimateContextTokens(body)).toBeLessThanOrEqual(limit);
    }
    expect(JSON.stringify(vertexBodies[2])).toContain('DENIED_READ_SIGNATURE');
    expect(JSON.stringify(vertexBodies[3])).toContain('SECOND_READ_SIGNATURE');
    expect(
      responses(vertexBodies[3]).filter((part: any) => part.id === 'denied-between-reads')
    ).toHaveLength(1);
    expect(target.connection.protocol).toBe('vertex-gemini-v1');
    expect(fixed).toEqual(original);
  });

  test('when original reads and their summary both exceed the hard limit no further main request is sent', async () => {
    const fixed = await fixedHeavySnapshot(),
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
    'accumulated reads are admitted before the next send; compaction %s preserves originals',
    async (outcome) => {
      const fixed = await oversizedSnapshot();
      fixed.settings.maxCalls = outcome === 'call-limit' ? 2 : 8;
      const original = structuredClone(fixed);
      const log = hooks();
      let revoked = false;
      log.value.authorize = (connection) => ({ ...connection, enabled: !revoked });
      const bodies = script([
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
          revoked = outcome === 'authorization-revoked';
          return outcome === 'eof' ? sse({ type: 'text_delta', delta: 'Incomplete' }) : completed();
        },
        (body) => {
          expect(body.role).toBe('main');
          expect(body).not.toHaveProperty('opaqueState');
          expect(body.input.results).toEqual([]);
          expect(body).not.toHaveProperty('bootstrap');
          const history = body.input.source.completedToolHistory as { events: ToolEvent[] };
          expect(history.events).toHaveLength(1);
          expect(history.events[0]).toMatchObject({
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
      expect(log.events.filter((event) => event.name === 'story.read')).toHaveLength(4);
      if (outcome === 'completed') {
        expect(result).toMatchObject({ status: 'completed', usage: { modelCalls: 3 } });
        expect(log.events.at(-1)).toMatchObject({ name: 'context.compact' });
        expect(
          (log.events.at(-1)!.result as { beforeTokens: number }).beforeTokens
        ).toBeGreaterThan(8192);
        expect(bodies).toHaveLength(3);
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
        expect(bodies).toHaveLength(outcome === 'call-limit' ? 1 : 2);
        expect(log.events.some((event) => event.name === 'context.compact')).toBe(
          outcome === 'authorization-revoked'
        );
      }
    }
  );

  test.each(['single', 'batch', 'mixed'] as const)(
    'Vertex signed %s continuation becomes a fresh text reference after compaction, then resumes native reads',
    async (mode) => {
      const fixed = await oversizedSnapshot(),
        target = fixed.profile!.models.main!,
        log = hooks();
      target.modelId = VERTEX_GEMINI_MODEL_ID;
      target.connection = {
        ...target.connection,
        protocol: 'vertex-gemini-v1',
        endpoint:
          'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models',
        credentialRef: 'UIMORI_PROVIDER_VERTEX_TEST',
      };
      const original = structuredClone(fixed);
      log.value.resolveCredential = () => 'SYNTHETIC_VERTEX_TOKEN';
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
                  id: `${prefix}-denied`,
                  name: 'story.read',
                  args: { sceneNumber: 999999 },
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
          expect(body.input.source.part).not.toContain('vertex-large-denied');
          return completed();
        }
        expect(String(url)).toBe(
          `${target.connection.endpoint}/${target.modelId}:streamGenerateContent?alt=sse`
        );
        vertexBodies.push(body);
        if (vertexBodies.length === 1)
          return reply(readParts('vertex-large', 16000, 'OLD_SIGNED_READ'));
        const text = JSON.stringify(body);
        expect(text).toContain('host-completed-tool-history');
        expect(text).toContain('host-compacted-reads');
        expect(text).not.toContain('OLD_SIGNED_READ');
        expect(text).not.toContain('skip_thought_signature_validator');
        if (mode === 'mixed') expect(text).toContain('vertex-large-denied');
        if (vertexBodies.length === 2) {
          expect(
            body.contents.every((message: any) =>
              message.parts.every((part: any) => !part.functionCall && !part.functionResponse)
            )
          ).toBe(true);
          return reply(readParts('fresh', 40, 'NEW_SIGNED_READ'));
        }
        expect(vertexBodies).toHaveLength(3);
        expect(text).toContain('NEW_SIGNED_READ');
        expect(body.contents.at(-1).parts[0].functionResponse).toMatchObject({
          id: 'fresh-read',
          name: 'story.read',
        });
        expect(body.contents.at(-1).parts).toHaveLength(
          mode === 'single' ? 1 : mode === 'batch' ? 2 : 3
        );
        return reply([{ text: finalText }]);
      });
      const result = await runMain(fixed, log.value);
      expect(result).toMatchObject({
        status: 'completed',
        text: finalText,
        usage: { modelCalls: 4 },
      });
      expect(summaryBodies).toHaveLength(1);
      expect(vertexBodies).toHaveLength(3);
      expect(
        log.events.filter((event) => event.name === 'story.read' && !event.denied)
      ).toHaveLength(mode === 'single' ? 2 : 4);
      expect(log.events.filter((event) => event.denied)).toHaveLength(mode === 'mixed' ? 2 : 0);
      expect(fixed).toEqual(original);
    }
  );

  test('repeated compaction preserves exact historical receipts and read references, including after summary failure', async () => {
    const fixed = await oversizedSnapshot(),
      log = hooks();
    fixed.profile!.models.main!.inputTokenLimit = 16384;
    fixed.contextPlan!.budget.inputTokenLimit = 16384;
    fixed.profile!.contextModel!.inputTokenLimit = 65536;
    const original = structuredClone(fixed);
    // Historical receipts remain valid data after the model-facing tool is retired.
    const receipts: ToolEvent[] = Array.from({ length: 9 }, (_, i) => ({
      callId: `write-${i}`,
      name: 'context.write',
      args: { summary: `Saved ${i}` },
      result: {
        saved: true,
        checkpoint: { id: `historical-${i}`, revision: i + 1, hash: `hash-${i}` },
      },
      denied: false,
    }));
    const reads = (prefix: string, offset: number) =>
      Array.from({ length: 4 }, (_, i) =>
        executeTool(fixed, {
          callId: `${prefix}-${i}`,
          name: 'story.read',
          args: { sceneNumber: i + 1, offset, limit: 16000 },
        })
      );
    const firstReads = reads('first-read', 0),
      secondReads = reads('second-read', 1),
      usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      bodies = script([
        () => completed(),
        (body) => {
          expect(body.input.source.part).toContain('host-compacted-reads');
          expect(body.input.source.part).toContain('second-read-0');
          return completed();
        },
        () => sse({ type: 'text_delta', delta: 'Incomplete summary' }),
      ]);
    const firstInput = [...receipts, ...firstReads],
      preservedInput = structuredClone(firstInput);
    const first = await compactToolReads(
      fixed,
      firstInput,
      log.value,
      usage,
      projectedTokens(fixed)
    );
    expect(first.slice(0, 9)).toEqual(receipts);
    const second = await compactToolReads(
      fixed,
      [...first, ...secondReads],
      log.value,
      usage,
      projectedTokens(fixed)
    );
    expect(second).toHaveLength(10);
    expect(second.slice(0, 9)).toEqual(receipts);
    const references = (
      second.at(-1)!.result as {
        references: { name: string; args: Json; returned: { source: Json; sceneScope: Json } }[];
      }
    ).references;
    const allReads = [...firstReads, ...secondReads];
    expect(references.map(({ name, args }) => ({ name, args }))).toEqual(
      allReads.map(({ name, args }) => ({ name, args }))
    );
    expect(references.map((reference) => reference.returned.source)).toEqual(
      allReads.map((event) => (event.result as { source: Json }).source)
    );
    expect(references.map((reference) => reference.returned.sceneScope)).toEqual(
      allReads.map((event) => (event.result as { sceneScope: Json }).sceneScope)
    );
    const failedInput = [...second, ...reads('failed-read', 2)],
      beforeFailure = structuredClone(failedInput);
    await expect(
      compactToolReads(fixed, failedInput, log.value, usage, projectedTokens(fixed))
    ).rejects.toThrow('CONTEXT_TOOL_COMPACTION_EOF');
    expect(failedInput).toEqual(beforeFailure);
    expect(firstInput).toEqual(preservedInput);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect(body.role).toBe('context');
      expect(body.input.source.part).not.toContain('write-0');
      expect(body.input.source.part).not.toContain('write-8');
    }
    expect(fixed).toEqual(original);
  });

  test('a completed read cannot execute again after automatic compaction', async () => {
    const fixed = await oversizedSnapshot(),
      original = structuredClone(fixed),
      log = hooks();
    const bodies = script([
      (_body, n) =>
        toolTurn(
          Array.from({ length: 4 }, (_, i) => ({
            id: `read-${i}`,
            name: 'story.read',
            args: { sceneNumber: i + 1, limit: 16000 },
          })),
          n
        ),
      () => completed(),
      (body, n) => {
        expect(body).not.toHaveProperty('opaqueState');
        expect(body.input.source.completedToolHistory).toBeDefined();
        return toolTurn(
          [{ id: 'read-0', name: 'story.read', args: { sceneNumber: 1, limit: 40 } }],
          n
        );
      },
    ]);
    expect(await runMain(fixed, log.value)).toMatchObject({
      status: 'error',
      error: 'DUPLICATE_TOOL_ID',
      usage: { modelCalls: 3 },
    });
    expect(bodies.map((body) => body.role)).toEqual(['main', 'context', 'main']);
    expect(log.events.filter((event) => event.name === 'story.read')).toHaveLength(4);
    expect(log.events.filter((event) => event.name === 'context.compact')).toHaveLength(1);
    expect(fixed).toEqual(original);
  });

  test('fresh read-compaction requests keep derived prose and exact receipts outside instructions on every codec', async () => {
    const fixed = await snapshot();
    const original = structuredClone(fixed);
    const marker = 'DERIVED_CLAIM_ONLY: the keeper may distrust Mira; this is an interpretation.';
    const receipt: ToolEvent = {
      callId: 'saved-before-compaction',
      name: 'context.write',
      args: { summary: 'saved separately' },
      result: {
        saved: true,
        checkpoint: { id: 'checkpoint-exact', revision: 2, hash: 'receipt-hash' },
      },
      denied: false,
    };
    const read: ToolEvent = {
      callId: 'read-before-compaction',
      name: 'story.read',
      args: { sceneNumber: 1 },
      denied: false,
      result: {
        kind: 'host-compacted-reads',
        summary: marker,
        references: [
          {
            name: 'story.read',
            args: { sceneNumber: 1 },
            returned: {
              source: {
                revision: 'chapter-0',
                hash: fixed.history[0].contentHash,
                start: 10,
                end: 80,
              },
            },
          },
        ],
      },
    };
    // A subsequent compaction carries prior receipts too, without changing the saved snapshot.
    for (const events of [[read], [receipt, read]]) {
      const { request } = buildMainProviderRequest(fixed, { completedToolHistory: events });
      const response = encodeResponses({ ...request, modelId: 'gpt-5.6' }).body as Record<
        string,
        any
      >;
      const chat = encodeChat({ ...request, modelId: 'gpt-5.6' }).body as Record<string, any>;
      const anthropic = encodeAnthropic({ ...request, modelId: 'claude-opus-5' }).body as Record<
        string,
        any
      >;
      const vertex = encodeVertex({ ...request, modelId: VERTEX_GEMINI_MODEL_ID }).body as Record<
        string,
        any
      >;
      const codex = buildCodexTurn(request);
      const bodies = [
        {
          codec: 'Responses',
          instructions: [
            response.instructions,
            ...response.input.filter((m: any) => m.role === 'system'),
          ],
          data: response.input.filter((m: any) => m.role !== 'system'),
        },
        {
          codec: 'Chat',
          instructions: chat.messages.filter((m: any) => m.role === 'system'),
          data: chat.messages.filter((m: any) => m.role !== 'system'),
        },
        { codec: 'Anthropic', instructions: anthropic.system, data: anthropic.messages },
        { codec: 'Vertex', instructions: vertex.systemInstruction, data: vertex.contents },
        {
          codec: 'Codex',
          instructions: codex.developerInstructions,
          data: JSON.parse(codex.inputText),
        },
      ];
      for (const { codec, instructions, data } of bodies) {
        expect(JSON.stringify(instructions), codec).not.toContain(marker);
        expect(JSON.stringify(data).split(marker).length - 1, codec).toBe(1);
        expect(JSON.stringify(data), codec).toContain('read-before-compaction');
        expect(JSON.stringify(data), codec).toContain(fixed.history[0].contentHash);
        expect(JSON.stringify(data), codec).toContain('same-request-in-progress');
        if (events.length === 2) expect(JSON.stringify(data), codec).toContain('checkpoint-exact');
      }
      expect(request.input.source).toMatchObject({ completedToolHistory: { events } });
      expect(request.prompt!.messages.at(-1)!.content[0].text).toContain('Host continuation');
      expect(request).not.toHaveProperty('opaqueState');
      expect(request.stable.tools).toEqual(buildMainProviderRequest(fixed).request.stable.tools);
    }
    expect(fixed).toEqual(original);
  });
});

test.each([1, 16])(
  'an 8192-token writer receives a bounded %i-reference read without immediate summarization',
  async (count) => {
    const fixed = await snapshot();
    fixed.history = [];
    fixed.logicalHistory = [];
    fixed.parentRevision = null;
    fixed.settings.maxCalls = 10;
    const target = fixed.profile!.models.main!;
    target.inputTokenLimit = 8192;
    target.connection.protocol = 'openai-chat-v1';
    target.connection.endpoint = `${origin}/v1/chat/completions`;
    fixed.profile!.contextModel = { ...structuredClone(target), modelId: 'synthetic-summary' };
    fixed.resources = Array.from({ length: 16 }, (_, index) => ({
      id: `lore-${index}`,
      chatId: fixed.chatId,
      kind: 'lore' as const,
      revision: 1,
      title: `Reference ${index}`,
      description: '',
      loading: 'discoverable' as const,
      text:
        `EXACT_LORE_${index}: ` +
        '항구의 종이 울리자 소녀는 젖은 편지를 접고 등대를 바라보았다. '.repeat(200),
    }));
    await refreshNativeSnapshot(fixed);
    const ready = seedContextPlan(fixed);
    const bodies: any[] = [];
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      bodies.push(body);
      const first = bodies.length === 1;
      expect(body.model).not.toBe('synthetic-summary');
      const name = body.tools.find((tool: any) => tool.function.name.endsWith('_knowledge_read'))
        .function.name;
      const delta = first
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'bulk-read',
                type: 'function',
                function: {
                  name,
                  arguments: JSON.stringify({
                    ids: ready.resources.slice(0, count).map(({ id }) => id),
                    limit: 4096,
                  }),
                },
              },
            ],
          }
        : { role: 'assistant', content: finalText };
      const response = sse(
        {
          id: 'synthetic-response',
          choices: [{ index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop' }],
        },
        {
          id: 'synthetic-response',
          choices: [],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }
      );
      return new Response((await response.text()) + 'data: [DONE]\n\n', {
        headers: response.headers,
      });
    });
    const observed = hooks();
    const result = await runMain(ready, observed.value);
    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => estimateContextTokens(body) <= 8192)).toBe(true);
    expect(observed.events.some((event) => event.name === 'context.compact')).toBe(false);
    const read = observed.events.find((event) => event.name === 'knowledge.read')!.result as any;
    expect(read.items[0].read.text).toBe(ready.resources[0].text.slice(0, 4096));
    expect(read.nextIndex).toBe(count === 1 ? null : 1);
    expect(JSON.stringify(bodies[1])).toContain('EXACT_LORE_0');
  }
);

test('read compaction keeps bounded knowledge page and per-item continuation metadata exact', async () => {
  const fixed = await snapshot();
  fixed.profile!.contextModel = { ...model(), inputTokenLimit: 32768 };
  fixed.resources = Array.from({ length: 15 }, (_, index) => ({
    id: `lore-${index}`,
    chatId: fixed.chatId,
    kind: 'lore' as const,
    revision: 1,
    title: `Reference ${index}`,
    description: '',
    text: 'Exact source. '.repeat(500),
  }));
  await refreshNativeSnapshot(fixed);
  const event = executeTool(fixed, {
    callId: 'page',
    name: 'knowledge.read',
    args: { ids: ['missing', ...fixed.resources.map(({ id }) => id)] },
  });
  const page = event.result as any;
  expect(page.nextIndex).toBe(2);
  script([() => completed()]);
  const compacted = await compactToolReads(
    fixed,
    [event],
    hooks().value,
    { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    projectedTokens(fixed)
  );
  expect(compacted[0].result).toMatchObject({
    references: [
      {
        name: 'knowledge.read',
        args: event.args,
        returned: {
          total: 16,
          nextIndex: 2,
          items: [
            { id: 'missing', denied: true, error: { code: 'RESOURCE_UNAVAILABLE' } },
            {
              id: 'lore-0',
              denied: false,
              source: page.items[1].read.source,
              range: { start: 0, end: 4096 },
              nextOffset: 4096,
            },
          ],
        },
      },
    ],
  });
});
