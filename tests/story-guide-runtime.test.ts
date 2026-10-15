import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { defaultProfile } from '../core/product.js';
import { defaultStoryGuideConfig } from '../core/story-guide.js';
import type { RunSnapshot } from '../core/types.js';
import type { ProviderResult, WireRecord } from '../core/transport.js';
import { prepareInputContext } from '../server/context-compaction.js';
import { seedContextPlan } from '../server/context-planning.js';
import { buildMainProviderRequest, encodeMainPreview } from '../server/main-request.js';
import { prepareNativeRisuRun } from '../server/risu-native-run.js';
import {
  applyStoryGuide,
  prepareStoryGuide,
  storyGuideReservedTokens,
  StoryGuideCancelledError,
  type StoryGuideHooks,
} from '../server/story-guide-runtime.js';
import { nativePrompt } from './fixtures/native-prompt.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const sse = (...events: unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
const completed = (text = '원작 참고: 모델 지식·원문 미확인.\n현재 이야기: 재회를 기다려요.') =>
  sse(
    { type: 'text_delta', delta: text },
    { type: 'usage', inputTokens: 11, outputTokens: 7, costUsd: 0.01 },
    { type: 'done', reason: 'stop' }
  );

async function snapshot() {
  const history = ['ORIGINAL_OLD_SCENE', 'ORIGINAL_RECENT_SCENE'].map((text, index) => ({
    revision: `source-${index}`,
    text,
    contentHash: hash(text),
  }));
  const profile = defaultProfile('guide-chat');
  const model = {
    id: 'main-model',
    revision: 1,
    title: 'Synthetic guide model',
    modelId: 'synthetic-main',
    connectionId: 'connection',
    inputTokenLimit: 8192,
    maxOutputTokens: 4096,
    temperature: null,
    connection: {
      id: 'connection',
      revision: 1,
      title: 'Synthetic fixture',
      protocol: 'fixture-sse-v1' as const,
      endpoint: 'http://127.0.0.1:44999/turn',
      enabled: true,
      catalog: [],
      catalogError: null,
    },
  };
  const source: RunSnapshot = {
    chatId: profile.chatId,
    parentRevision: history.at(-1)!.revision,
    settingsRevision: 1,
    settings: { maxCalls: 6 },
    request: '정체를 숨긴 채 재회하는 장면',
    history,
    resources: [],
    logicalHistory: history.flatMap((entry) => [
      {
        id: `request:${entry.revision}`,
        role: 'user' as const,
        text: `USER_${entry.revision}`,
        sourceRevision: entry.revision,
        sourceHash: entry.contentHash,
      },
      {
        id: `source:${entry.revision}`,
        role: 'assistant' as const,
        text: entry.text,
        sourceRevision: entry.revision,
        sourceHash: entry.contentHash,
      },
    ]),
    storyGuide: {
      revision: 1,
      config: {
        ...defaultStoryGuideConfig(),
        enabled: true,
        work: '가상의 원작',
        position: '2화까지',
      },
    },
    profile: {
      ...profile,
      models: { main: model },
      contextModel: model,
      promptPresets: {
        main: {
          id: 'prompt',
          revision: 1,
          title: 'Synthetic',
          role: 'main',
          program: nativePrompt('WRITER_STYLE_DO_NOT_COPY_TO_GUIDE'),
        },
      },
    },
  };
  const prepared = seedContextPlan(await prepareNativeRisuRun(source));
  prepared.contextPlan!.status = 'ready';
  return prepared;
}

function observed(overrides: Partial<StoryGuideHooks> = {}) {
  const wires: WireRecord[] = [];
  const results: ProviderResult[] = [];
  const hooks: StoryGuideHooks = {
    signal: new AbortController().signal,
    authorize: (connection) => connection,
    onAttemptStart: (wire) => {
      wires.push(structuredClone(wire));
      return `guide-attempt-${wires.length}`;
    },
    onAttemptFinish: (_id, result) => {
      results.push(structuredClone(result));
    },
    ...overrides,
  };
  return { hooks, wires, results };
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completed());
});
afterEach(() => {
  vi.restoreAllMocks();
});

test('guide consumes prepared logical history and one summary, ignores prior advice, and caches only identical effective inputs', async () => {
  const source = await snapshot();
  source.contextPlan!.compacted = [
    { revision: source.history[0].revision, hash: source.history[0].contentHash! },
  ];
  source.contextPlan!.recentSourceRevisions = [source.history[1].revision];
  source.contextPlan!.summary = 'DERIVED_OLD_SUMMARY';
  source.nativeRisuExecution!.request = 'NATIVE_CURRENT_REQUEST';
  source.nativeRisuExecution!.history.at(-1)!.text = 'NATIVE_RECENT_SCENE';
  source.storyGuide!.brief = {
    fingerprint: 'old',
    text: 'OLD_GUIDE_NOT_SOURCE',
    createdAt: '2026-10-15T00:00:00Z',
    parentRevision: null,
    configRevision: 1,
    modelTitle: 'old',
  };
  const log = observed();
  const first = await prepareStoryGuide(source, log.hooks, { runId: 'first', reserveCalls: 1 });
  expect(first).toMatchObject({
    error: null,
    cached: false,
    usage: { modelCalls: 1, inputTokens: 11, outputTokens: 7, costUsd: 0.01 },
  });
  expect(first.brief).toMatchObject({
    runId: 'first',
    parentRevision: 'source-1',
    configRevision: 1,
  });
  const wire = JSON.stringify(log.wires[0].body);
  expect(log.wires[0].body).toMatchObject({ generation: { maxOutputTokens: 4096 } });
  expect(wire).toContain('NATIVE_CURRENT_REQUEST');
  expect(wire).toContain('NATIVE_RECENT_SCENE');
  expect(wire.match(/DERIVED_OLD_SUMMARY/gu)).toHaveLength(1);
  for (const absent of [
    'ORIGINAL_OLD_SCENE',
    'ORIGINAL_RECENT_SCENE',
    'OLD_GUIDE_NOT_SOURCE',
    'WRITER_STYLE_DO_NOT_COPY_TO_GUIDE',
  ])
    expect(wire).not.toContain(absent);

  const repeated = structuredClone(source);
  repeated.request = 'Raw request changed but the consumed native request is identical';
  repeated.executionClock = { iso: '2026-10-16T00:00:00Z', unix: 1 };
  const cached = await prepareStoryGuide(repeated, log.hooks, {
    cachedBrief: first.brief,
    runId: 'second',
    reserveCalls: 1,
  });
  expect(cached).toMatchObject({
    cached: true,
    usage: { modelCalls: 0 },
    brief: { runId: 'second' },
  });
  expect(log.wires).toHaveLength(1);
  repeated.nativeRisuExecution!.history.at(-1)!.text = 'NATIVE_CORRECTED_SCENE';
  const changed = await prepareStoryGuide(repeated, log.hooks, {
    cachedBrief: first.brief,
    reserveCalls: 1,
  });
  expect(changed.cached).toBe(false);
  expect(changed.brief!.fingerprint).not.toBe(first.brief!.fingerprint);
  expect(log.wires).toHaveLength(2);
});

test('disabled automatic guide is a no-op, explicit requests work, and writer calls remain reserved', async () => {
  const source = await snapshot();
  source.storyGuide!.config.enabled = false;
  const log = observed();
  expect(await prepareStoryGuide(source, log.hooks)).toMatchObject({
    brief: null,
    error: null,
    usage: { modelCalls: 0 },
  });
  expect(log.wires).toHaveLength(0);
  expect((await prepareStoryGuide(source, log.hooks, { force: true })).brief).toBeTruthy();
  expect(
    (await prepareStoryGuide(source, log.hooks, { question: '이 인물의 행동 이유는?' })).brief
  ).toBeTruthy();
  source.storyGuide!.config.enabled = true;
  source.settings.maxCalls = 2;
  const exhausted = await prepareStoryGuide(
    source,
    { ...log.hooks, initialUsage: { modelCalls: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 } },
    { reserveCalls: 1 }
  );
  expect(exhausted).toMatchObject({
    brief: null,
    error: 'STORY_GUIDE_CALL_BUDGET_EXHAUSTED',
    usage: { modelCalls: 0 },
  });
  expect(log.wires).toHaveLength(2);
});

test('cancellation after the provider settles propagates with its accounted usage', async () => {
  const source = await snapshot();
  const controller = new AbortController();
  const log = observed({
    signal: controller.signal,
    onAttemptFinish: () => {
      controller.abort();
    },
  });
  const error = await prepareStoryGuide(source, log.hooks).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(StoryGuideCancelledError);
  expect(error).toMatchObject({
    usage: { modelCalls: 1, inputTokens: 11, outputTokens: 7, costUsd: 0.01 },
  });
});

test('failed or oversized guide removes stale advice; admitted guide reaches the measured writer body', async () => {
  const source = await snapshot();
  const log = observed();
  const result = await prepareStoryGuide(source, log.hooks);
  const applied = applyStoryGuide(source, result);
  const built = buildMainProviderRequest(applied);
  const body = encodeMainPreview(built.request, applied.profile!.models.main!).body;
  expect(JSON.stringify(body)).toContain(result.brief!.text.replaceAll('\n', '\\n'));
  expect(applied.contextPlan!.estimatedInputTokens).toBeLessThanOrEqual(8192);
  const failed = applyStoryGuide(applied, {
    ...result,
    brief: null,
    error: 'STORY_GUIDE_PROVIDER_FAILED',
  });
  expect(failed.storyGuide!.brief).toBeUndefined();
  expect(failed.storyGuide!.error).toBe('STORY_GUIDE_PROVIDER_FAILED');
  expect(JSON.stringify(buildMainProviderRequest(failed).request)).not.toContain(
    result.brief!.text
  );
  const oversized = applyStoryGuide(source, {
    ...result,
    brief: { ...result.brief!, text: 'oversized guide '.repeat(10_000) },
  });
  expect(oversized.storyGuide).toMatchObject({ error: 'STORY_GUIDE_WRITER_CONTEXT_TOO_LARGE' });
  expect(oversized.storyGuide!.brief).toBeUndefined();
});

test('guide space participates in the first compaction instead of triggering another summary after analysis', async () => {
  const source = await snapshot();
  const measureInput = (projected: RunSnapshot) => ({
    snapshot: projected,
    estimatedInputTokens: 1_000 + projected.contextPlan!.recentSourceRevisions.length * 2_500,
  });
  const log = observed();
  const hooks = {
    ...log.hooks,
    onInput: () => {},
    onToolEvent: () => {},
    onProgress: () => {},
    measureInput,
  };
  const without = await prepareInputContext(source, hooks);
  expect(without.usage.modelCalls).toBe(0);
  const withGuide = await prepareInputContext(source, {
    ...hooks,
    reserveInputTokens: storyGuideReservedTokens(source),
  });
  expect(withGuide.usage.modelCalls).toBe(1);
  expect(withGuide.snapshot.contextPlan!.compacted).toHaveLength(1);
  expect(withGuide.snapshot.contextPlan!.estimatedInputTokens).toBe(
    3_500 + storyGuideReservedTokens(source)
  );
  expect(withGuide.snapshot.logicalHistory).toEqual(source.logicalHistory);
  delete source.profile!.contextModel;
  const withoutSummaryModel = await prepareInputContext(source, {
    ...hooks,
    reserveInputTokens: storyGuideReservedTokens(source),
  });
  expect(withoutSummaryModel.usage.modelCalls).toBe(0);
  expect(withoutSummaryModel.snapshot.contextPlan!.compacted).toHaveLength(0);
  expect(log.wires).toHaveLength(1);
});
