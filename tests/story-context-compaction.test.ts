import { afterEach, describe, expect, test } from 'vitest';
import { memoryHash, type MemoryEntry } from '../core/memory.js';
import { defaultProfile, type ModelSnapshot } from '../core/product.js';
import { defaultStoryConfig, type StoryJob, type StorySnapshot } from '../core/story.js';
import type { Json, ProviderResult, WireRecord } from '../core/transport.js';
import type { RunSnapshot, Source, ToolEvent } from '../core/types.js';
import type { ContextPlan } from '../core/context-plan.js';
import { prepareInputContext } from '../server/context-compaction.js';
import { seedContextPlan } from '../server/context-planning.js';
import { runStoryJob, type StoryHooks, type StoryInput } from '../server/story-runner.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});
type Body = {
  role: string;
  modelId: string;
  input: {
    controls: Record<string, unknown>;
    source: any;
    history?: { revision: string; text: string }[];
    results: any[];
  };
  stable: { contract: string; tools: { name: string }[] };
};
async function fixture(
  handler: (
    body: Body,
    response: Parameters<Parameters<typeof loopbackProvider>[0]>[1]
  ) => void | Promise<void>
) {
  const failures: unknown[] = [];
  const server = await loopbackProvider(async (request, response) => {
    try {
      await handler(JSON.parse(request.body), response);
    } catch (error) {
      failures.push(error);
      throw error;
    }
  });
  closes.push(server.close);
  return { ...server, failures };
}
const paragraph = '비 오는 항구에서 미라는 약속을 기억해요. 진실인지 아직 알 수 없어요.\n';
const currentText = 'CURRENT_SOURCE_ONCE: Mira spent three coins at the harbor.';
const oldScenes = () =>
  Array.from(
    { length: 8 },
    (_, index) => `OLD_SOURCE_${index}: 미라는 오래된 단서를 확인했어요.\n${paragraph.repeat(65)}`
  );
function selected(endpoint: string, role: string, inputTokenLimit = 8192): ModelSnapshot {
  return {
    id: `${role}-model`,
    revision: 1,
    title: `Synthetic ${role}`,
    modelId: `fixture-${role}`,
    connectionId: `${role}-connection`,
    maxOutputTokens: 4096,
    temperature: null,
    inputTokenLimit,
    connection: {
      id: `${role}-connection`,
      revision: 1,
      title: 'Temporary loopback fixture',
      protocol: 'fixture-sse-v1',
      endpoint,
      enabled: true,
      catalog: [],
      catalogError: null,
    },
  };
}
function bundle(
  kind: 'state' | 'memory',
  endpoint: string,
  options: {
    texts?: string[];
    sourceText?: string;
    inputTokenLimit?: number;
    mainInputTokenLimit?: number;
  } = {}
) {
  const history = (options.texts ?? oldScenes()).map((text, index) => ({
    revision: `old-source-${index}`,
    text,
    contentHash: memoryHash(text),
  }));
  const text = options.sourceText ?? currentText;
  const source: Source = {
    id: 'current-source',
    chatId: 'story-compaction-chat',
    parentRevision: history.at(-1)?.revision ?? null,
    runId: 'current-run',
    text,
    hash: memoryHash(text),
  };
  const stateModel = selected(endpoint, 'state', options.inputTokenLimit),
    memoryModel = selected(endpoint, 'memory', options.inputTokenLimit),
    mainModel = selected(endpoint, 'main', options.mainInputTokenLimit);
  const story: StorySnapshot = {
    config: {
      ...defaultStoryConfig(),
      revision: 1,
      stateModel: { id: stateModel.id },
      memory: {
        enabled: true,
        model: { id: memoryModel.id },
        recentCount: 2,
        maxPacketChars: 60000,
      },
      module: {
        id: 'coin-module',
        revision: 1,
        name: 'Synthetic coins',
        mode: 'authoritative',
        fields: {
          coins: {
            type: 'number',
            initial: 10,
            min: 0,
            max: 100,
            description: 'Spending three coins',
          },
        },
        rules: { 'spend-three': { field: 'coins', delta: -3 } },
      },
    },
    state: {
      id: 'initial-state',
      sourceRevision: null,
      sourceHash: null,
      moduleRevision: 1,
      values: { coins: 10 },
      canonical: true,
    },
    memory: null,
    models: { state: stateModel, memory: memoryModel },
    waiting: false,
    lineageHash: 'synthetic-lineage',
    canonHash: memoryHash('[]'),
  };
  const snapshot: RunSnapshot = {
    chatId: source.chatId,
    parentRevision: source.parentRevision,
    settingsRevision: 1,
    settings: { preset: 'calm', mode: 'direct', translation: false, status: true, maxCalls: 16 },
    request: 'USER_CURRENT_REQUEST: Preserve my choices.',
    history,
    resources: [],
    story,
    logicalHistory: history.flatMap((item) => [
      {
        id: `user:${item.revision}`,
        role: 'user' as const,
        text: `USER_WISH_${item.revision}: 제 인물의 선택을 대신 정하지 마세요.`,
        sourceRevision: item.revision,
        sourceHash: item.contentHash,
      },
      {
        id: `assistant:${item.revision}`,
        role: 'assistant' as const,
        text: item.text,
        sourceRevision: item.revision,
        sourceHash: item.contentHash,
      },
    ]),
    profile: {
      ...defaultProfile(source.chatId),
      contents: [],
      models: { main: mainModel },
      routes: { main: { id: mainModel.id }, translation: null, status: null, image: null },
      promptPresets: {
        main: {
          id: 'main-prompt',
          revision: 1,
          title: 'Synthetic main',
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
                template: [
                  {
                    kind: 'text',
                    text: 'Preserve user agency and distinguish facts from beliefs.',
                  },
                ],
              },
              {
                id: 'history',
                title: 'History including current input',
                kind: 'history',
                from: 0,
                to: 'end',
              },
            ],
          },
        },
      },
    },
  };
  const job: StoryJob = {
    id: `job-${kind}`,
    chatId: source.chatId,
    sourceRevision: source.id,
    sourceHash: source.hash,
    kind,
    configRevision: 1,
    generation: 1,
    owner: 'synthetic-worker',
    status: 'running',
    error: null,
    mock: false,
    createdAt: '',
    updatedAt: '',
    result: null,
  };
  return { source, snapshot, job };
}
function observed(origin: string) {
  const inputs: StoryInput[] = [],
    events: ToolEvent[] = [],
    attempts: { id: string; wire: WireRecord; result?: ProviderResult }[] = [];
  const hooks: StoryHooks = {
    signal: new AbortController().signal,
    approvedOrigins: [origin],
    authorize: (connection) => connection,
    onInput: (input) => {
      inputs.push(structuredClone(input));
    },
    onToolEvent: (event) => {
      events.push(structuredClone(event));
    },
    onAttemptStart: (wire) => {
      const id = `attempt-${attempts.length}`;
      attempts.push({ id, wire: structuredClone(wire) });
      return id;
    },
    onAttemptFinish: (id, result) => {
      attempts.find((attempt) => attempt.id === id)!.result = structuredClone(result);
    },
  };
  return { hooks, inputs, events, attempts };
}
const isSummary = (body: Body) => body.input.controls.purpose === 'input-context-compaction';
const summary = (body: Body) =>
  `${body.input.source.previousSummary ?? '미라는 오래된 단서를 조사했으며 일부 내용은 아직 불확실해요.'}\n사용자의 선택권과 대화 순서를 유지해요.`;
const finishText = (text: string): Json[] => [
  { type: 'text_delta', delta: text },
  { type: 'usage', inputTokens: 13, outputTokens: 5 },
  { type: 'done', reason: 'stop' },
];
const finish = (value: unknown) => finishText(JSON.stringify(value));
function stateResult(source: Source) {
  const quote = 'spent three coins',
    start = source.text.indexOf(quote);
  return {
    sourceRevision: source.id,
    sourceHash: source.hash,
    moduleRevision: 1,
    operations: [
      {
        id: 'spend-one',
        kind: 'event',
        event: 'spend-three',
        evidence: { start, end: start + quote.length, quote },
      },
    ],
  };
}
function memoryResult(work: ReturnType<typeof bundle>): { entries: MemoryEntry[] } {
  const old = work.snapshot.history[0],
    quote = old.text.split('\n')[0];
  return {
    entries: [
      {
        id: 'observed-memory',
        chatId: work.source.chatId,
        atRevision: work.source.id,
        atHash: work.source.hash,
        kind: 'observed-story',
        text: '미라는 오래된 단서를 확인한 뒤 항구에서 동전 세 개를 썼어요.',
        sources: [
          { revision: old.revision, hash: old.contentHash!, start: 0, end: quote.length, quote },
          {
            revision: work.source.id,
            hash: work.source.hash,
            start: 0,
            end: work.source.text.length,
            quote: work.source.text,
          },
        ],
      },
    ],
  };
}
const latestPlan = (log: ReturnType<typeof observed>) =>
  log.inputs.findLast((input) => input.contextPlan?.status === 'ready')!.contextPlan!;
function strings(value: unknown): string[] {
  return typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(strings)
        : [];
}
async function mainCheckpoint(work: ReturnType<typeof bundle>, origin: string) {
  const log = observed(origin),
    plans: ContextPlan[] = [];
  const prepared = await prepareInputContext(seedContextPlan(work.snapshot), {
    ...log.hooks,
    onInput: () => {},
    onProgress: (plan) => {
      plans.push(plan);
    },
  });
  work.snapshot = prepared.snapshot;
  return { log, plan: prepared.snapshot.contextPlan!, plans };
}

describe('story runner uses input compaction without shrinking source evidence or tool scope', () => {
  test('long state ancestry is summarized through memory attempts before an exact current-source state proposal', async () => {
    const summaries: Body[] = [],
      stateBodies: Body[] = [];
    const server = await fixture(async (body, response) => {
      expect(log.attempts).toHaveLength(server.requests.length);
      if (isSummary(body)) {
        expect(body.role).toBe('memory');
        summaries.push(body);
        await writeSse(response, finishText(summary(body)));
        return;
      }
      stateBodies.push(body);
      expect(body.role).toBe('state');
      expect(body.input.source).toMatchObject({
        revision: work.source.id,
        hash: work.source.hash,
        text: work.source.text,
        previousState: { coins: 10 },
      });
      expect(strings(body).filter((value) => value === work.source.text)).toHaveLength(1);
      expect(body.input.history!.some((item) => item.revision === work.source.id)).toBe(false);
      expect(body.input.history!.length).toBeLessThan(work.snapshot.history.length);
      expect(body.input.source.contextSummary.kind).toBe('derived-summary');
      await writeSse(response, finish(stateResult(work.source)));
    });
    const work = bundle('state', server.endpoint),
      original = structuredClone(work),
      log = observed(server.origin);
    const result = await runStoryJob(work, log.hooks);
    expect(server.failures).toEqual([]);
    expect(result).toEqual({
      status: 'completed',
      result: stateResult(work.source),
      error: null,
      mock: false,
    });
    expect(summaries.length).toBeGreaterThan(0);
    expect(stateBodies).toHaveLength(1);
    expect(log.attempts.map((attempt) => attempt.wire.role)).toEqual([
      ...summaries.map(() => 'memory'),
      'state',
    ]);
    const plan = latestPlan(log);
    expect(plan.compacted.length).toBeGreaterThan(0);
    expect(plan.summaryCalls).toBe(summaries.length);
    expect(plan.budget.inputTokenLimit).toBe(8192);
    for (const ref of plan.compacted)
      for (const message of work.snapshot.logicalHistory!.filter(
        (message) => message.sourceRevision === ref.revision
      )) {
        expect(
          summaries
            .flatMap((body) => body.input.source.fragments)
            .filter((part: any) => part.messageId === message.id)
            .map((part: any) => part.text)
            .join('')
        ).toBe(message.text);
      }
    expect(
      summaries
        .flatMap((body) => body.input.source.fragments)
        .some((part: any) => part.sourceRevision === work.source.id)
    ).toBe(false);
    expect(log.attempts.every((attempt) => attempt.result?.usage.costUsd === null)).toBe(true);
    expect(log.attempts.length).toBeLessThanOrEqual(work.snapshot.settings.maxCalls);
    expect(work).toEqual(original);
  });

  test('memory extraction validates compacted-ancestor quotes and hashes against the full original ancestry', async () => {
    let mode: 'valid' | 'bad-quote' | 'bad-hash' = 'valid';
    const extracted: Body[] = [];
    const server = await fixture(async (body, response) => {
      if (isSummary(body)) {
        await writeSse(response, finishText(summary(body)));
        return;
      }
      expect(body.role).toBe('memory');
      extracted.push(body);
      expect(
        body.input.history!.some((item) => item.revision === work.snapshot.history[0].revision)
      ).toBe(false);
      const output = memoryResult(work),
        entry = output.entries[0];
      if (entry.kind === 'observed-story') {
        if (mode === 'bad-quote') entry.sources[0].quote = 'INVENTED_QUOTE';
        if (mode === 'bad-hash') entry.sources[0].hash = 'f'.repeat(64);
      }
      await writeSse(response, finish(output));
    });
    const work = bundle('memory', server.endpoint),
      original = structuredClone(work),
      log = observed(server.origin);
    expect(await runStoryJob(work, log.hooks)).toMatchObject({
      status: 'completed',
      result: memoryResult(work),
      error: null,
    });
    expect(latestPlan(log).compacted[0].revision).toBe(work.snapshot.history[0].revision);
    mode = 'bad-quote';
    expect(await runStoryJob(work, observed(server.origin).hooks)).toMatchObject({
      status: 'failed',
      result: null,
      error: 'MEMORY_INVALID_SOURCE_RANGE',
    });
    mode = 'bad-hash';
    expect(await runStoryJob(work, observed(server.origin).hooks)).toMatchObject({
      status: 'failed',
      result: null,
      error: 'MEMORY_OUT_OF_SCOPE',
    });
    expect(server.failures).toEqual([]);
    expect(extracted).toHaveLength(3);
    expect(work).toEqual(original);
  });

  test('a current source exceeding the auxiliary limit is preserved whole and fails with zero provider transmissions', async () => {
    const server = await fixture(async () => {
      throw new Error('Oversized current source must never be sent');
    });
    const work = bundle('state', server.endpoint, {
        texts: [],
        sourceText: `${currentText}\n${paragraph.repeat(1500)}`,
      }),
      original = structuredClone(work),
      log = observed(server.origin);
    expect(await runStoryJob(work, log.hooks)).toMatchObject({
      status: 'failed',
      result: null,
      error: 'CONTEXT_FIXED_INPUT_TOO_LARGE',
    });
    expect(server.requests).toEqual([]);
    expect(server.failures).toEqual([]);
    expect(log.attempts).toEqual([]);
    expect(log.inputs.at(-1)).toMatchObject({
      source: { text: work.source.text, hash: work.source.hash },
      contextPlan: { status: 'failed', summaryCalls: 0, compacted: [] },
    });
    expect(work).toEqual(original);
  });

  test('a main checkpoint is reused and story.read can retrieve a compacted ancestor while other-branch IDs remain denied', async () => {
    let denied = false;
    const server = await fixture(async (body, response) => {
      if (isSummary(body)) {
        await writeSse(response, finishText(summary(body)));
        return;
      }
      expect(body.role).toBe('state');
      if (!body.input.results.length) {
        await writeSse(response, [
          {
            type: 'tool_delta',
            index: 0,
            id: 'read-old-source',
            name: 'story.read',
            argumentsDelta: JSON.stringify({
              id: denied ? 'other-branch-source' : work.snapshot.history[0].revision,
              offset: 0,
              limit: 80,
            }),
          },
          { type: 'done', reason: 'tool_calls' },
        ]);
        return;
      }
      expect(body.input.results[0]).toMatchObject({
        name: 'story.read',
        denied: false,
        result: {
          text: work.snapshot.history[0].text.slice(0, 80),
          source: {
            revision: work.snapshot.history[0].revision,
            hash: work.snapshot.history[0].contentHash,
          },
        },
      });
      await writeSse(response, finish(stateResult(work.source)));
    });
    const work = bundle('state', server.endpoint, { inputTokenLimit: 16384 }),
      checkpoint = await mainCheckpoint(work, server.origin);
    expect(checkpoint.plan.compacted.length).toBeGreaterThan(0);
    const original = structuredClone(work),
      log = observed(server.origin);
    expect(await runStoryJob(work, log.hooks)).toMatchObject({ status: 'completed', error: null });
    expect(server.failures).toEqual([]);
    expect(log.attempts.map((attempt) => attempt.wire.role)).toEqual(['state', 'state']);
    expect(latestPlan(log)).toMatchObject({
      compacted: checkpoint.plan.compacted,
      summary: checkpoint.plan.summary,
      summaryCalls: 0,
    });
    expect(log.events[0]).toMatchObject({ name: 'story.read', denied: false });
    denied = true;
    const outside = observed(server.origin);
    expect(await runStoryJob(work, outside.hooks)).toMatchObject({
      status: 'failed',
      result: null,
      error: 'READ_TOOL_DENIED',
    });
    expect(outside.attempts.map((attempt) => attempt.wire.role)).toEqual(['state']);
    expect(outside.events[0]).toMatchObject({
      denied: true,
      result: { code: 'RESOURCE_UNAVAILABLE' },
    });
    expect(work).toEqual(original);
  });

  test('a smaller auxiliary budget requires its own summary even when the main checkpoint already fits a larger window', async () => {
    const server = await fixture(async (body, response) => {
      await writeSse(
        response,
        isSummary(body) ? finishText(summary(body)) : finish(stateResult(work.source))
      );
    });
    const work = bundle('state', server.endpoint, { mainInputTokenLimit: 131072 }),
      main = await mainCheckpoint(work, server.origin);
    expect(main.plan).toMatchObject({
      status: 'ready',
      summaryCalls: 0,
      compacted: [],
      budget: { inputTokenLimit: 131072 },
    });
    expect(main.log.attempts).toEqual([]);
    const original = structuredClone(work),
      log = observed(server.origin),
      outcome = await runStoryJob(work, log.hooks);
    expect(server.failures).toEqual([]);
    expect(outcome).toMatchObject({ status: 'completed', error: null });
    const plan = latestPlan(log);
    expect(plan.budget.inputTokenLimit).toBe(8192);
    expect(plan.summaryCalls).toBeGreaterThan(0);
    expect(plan.compacted.length).toBeGreaterThan(0);
    expect(log.attempts.at(-1)!.wire.role).toBe('state');
    expect(log.attempts.slice(0, -1).every((attempt) => attempt.wire.role === 'memory')).toBe(true);
    expect(work).toEqual(original);
  });
});
