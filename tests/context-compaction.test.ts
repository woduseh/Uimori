import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { defaultProfile, type ModelSnapshot } from '../core/product.js';
import { defaultStoryConfig } from '../core/story.js';
import type { RunSnapshot } from '../core/types.js';
import type { ContextPlan } from '../core/context-plan.js';
import type { ProviderResult, WireRecord } from '../core/transport.js';
import {
  compilePromptProgram,
  validateProviderPrompt,
  type PromptHistoryMessage,
} from '../core/prompt-program.js';
import { estimateContextTokens } from '../core/context-budget.js';
import { createSourceSegmentFixture } from './fixtures/source-segments.js';
import { sourceLogicalHistoryForRequest } from '../core/source-context.js';
import {
  ContextCompactionError,
  prepareInputContext,
  type ContextCompactionHooks,
} from '../server/context-compaction.js';
import {
  contextSourceRefs,
  measureMainContext,
  seedContextPlan,
  validateContextPlan,
  withContextProjection,
} from '../server/context-planning.js';
import { buildMainProviderRequest } from '../server/main-request.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const origin = 'http://127.0.0.1:44999';
const paragraph = '비 오는 항구에서 미라는 약속을 기억해요. 진실인지 아직 알 수 없어요.\n';
const oldScenes = () =>
  Array.from({ length: 6 }, (_, index) => `장면 ${index}.\n${paragraph.repeat(70)}`);
const fixedPrompt = 'FIXED_INSTRUCTIONS: Preserve user agency. Character beliefs are uncertain.';
const currentRequest = 'CURRENT_USER_INPUT: 지금 장면에서 제 반응을 대신 정하지 마세요.';
const model = (id = 'main-model'): ModelSnapshot => ({
  id,
  revision: 1,
  title: id,
  modelId: `fixture-${id}`,
  connectionId: `connection-${id}`,
  inputTokenLimit: 8192,
  maxOutputTokens: 8192,
  temperature: null,
  connection: {
    id: `connection-${id}`,
    revision: 1,
    title: 'Synthetic loopback only',
    protocol: 'fixture-sse-v1',
    endpoint: `${origin}/turn`,
    enabled: true,
    catalog: [],
    catalogError: null,
  },
});
function snapshot(texts: string[] = []): RunSnapshot {
  const target = model();
  const history = texts.map((text, index) => ({
    revision: `source-${index}`,
    text,
    contentHash: hash(text),
  }));
  return seedContextPlan({
    chatId: 'synthetic-compaction-chat',
    parentRevision: history.at(-1)?.revision ?? null,
    settingsRevision: 1,
    settings: { preset: 'calm', mode: 'direct', translation: false, status: false, maxCalls: 16 },
    request: currentRequest,
    history,
    resources: [],
    logicalHistory: history.flatMap((source) => [
      {
        id: `user:${source.revision}`,
        role: 'user' as const,
        text: `USER_WISH_${source.revision}: 미라의 선택을 존중해 주세요.`,
        sourceRevision: source.revision,
        sourceHash: source.contentHash,
      },
      {
        id: `assistant:${source.revision}`,
        role: 'assistant' as const,
        text: source.text,
        sourceRevision: source.revision,
        sourceHash: source.contentHash,
      },
    ]),
    profile: {
      ...defaultProfile('synthetic-compaction-chat'),
      contents: [],
      models: { main: target },
      contextModel: target,
      routes: { main: { id: target.id }, translation: null, status: null, image: null },
      promptPresets: {
        main: {
          id: 'synthetic-fixed-prompt',
          revision: 1,
          title: 'Synthetic fixed prompt',
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
                template: [{ kind: 'text', text: fixedPrompt }],
              },
              { id: 'history', title: 'History', kind: 'history', from: 0, to: -1 },
              { id: 'current', title: 'Current', kind: 'current' },
            ],
          },
        },
      },
    },
  });
}
const sse = (...events: unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
const completed = (text: string, costUsd: number | null = null) =>
  sse(
    { type: 'text_delta', delta: text },
    { type: 'usage', inputTokens: 11, outputTokens: 7, costUsd },
    { type: 'opaque_state', state: 'OPAQUE_SUMMARY_CANARY' },
    { type: 'done', reason: 'stop' }
  );
type SummaryPayload = {
  previousSummary: string | null;
  sceneScope: { chatId: string; headRevision: string | null; headHash: string | null };
  fragments: {
    sourceRevision: string;
    sourceHash: string;
    sourceSceneNumber: number;
    messageId: string;
    role: string;
    offsetUtf16: number;
    totalUtf16: number;
    text: string;
  }[];
};
function observed(overrides: Partial<ContextCompactionHooks> = {}) {
  const progress: ContextPlan[] = [],
    wires: WireRecord[] = [],
    results: ProviderResult[] = [],
    events: string[] = [];
  const hooks: ContextCompactionHooks = {
    signal: new AbortController().signal,
    approvedOrigins: [origin],
    onInput: () => {},
    onToolEvent: () => {},
    authorize: (connection) => connection,
    onAttemptStart: (wire) => {
      events.push('start');
      wires.push(structuredClone(wire));
      return `attempt-${wires.length}`;
    },
    onAttemptFinish: (_id, result) => {
      events.push('finish');
      results.push(structuredClone(result));
    },
    onProgress: (plan) => {
      progress.push(structuredClone(plan));
    },
    ...overrides,
  };
  return { hooks, progress, wires, results, events };
}
function respondWithMergedSummary(log: ReturnType<typeof observed>) {
  const payloads: SummaryPayload[] = [];
  vi.mocked(fetch).mockImplementation(async (_url, options) => {
    expect(log.events.at(-1)).toBe('start');
    log.events.push('send');
    const wire = JSON.parse(String(options?.body));
    expect(wire.role).toBe('context');
    expect(wire.stable.tools).toEqual([]);
    expect(wire).not.toHaveProperty('opaqueState');
    expect(wire).not.toHaveProperty('contextBudget');
    expect(wire.generation.maxOutputTokens).toBe(4096);
    expect(estimateContextTokens(wire)).toBeLessThanOrEqual(8192);
    const source = wire.input.source as SummaryPayload;
    for (const fragment of source.fragments)
      expect(fragment.sourceSceneNumber).toBe(
        Number(fragment.sourceRevision.split('-').at(-1)) + 1
      );
    payloads.push(source);
    return completed(
      `${source.previousSummary ?? '미라가 약속을 기억하지만 진실은 불확실해요.'}\n추가 요약 ${payloads.length}. 사용자 의사를 보존해요.`
    );
  });
  return payloads;
}
async function failure(promise: ReturnType<typeof prepareInputContext>) {
  try {
    await promise;
    throw new Error('Expected compaction failure');
  } catch (error) {
    expect(error).toBeInstanceOf(ContextCompactionError);
    return error as ContextCompactionError;
  }
}
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('Unexpected provider access in synthetic compaction tests')
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('input context projection and durable summary calls', () => {
  test.each([
    { consumerLimit: 8192, outputLimit: 8192, target: 1024, hardCap: 4096 },
    { consumerLimit: 65536, outputLimit: 8192, target: 2048, hardCap: 4096 },
    { consumerLimit: 16384, outputLimit: 512, target: 256, hardCap: 512 },
  ])(
    'manual compaction gives a $consumerLimit-token consumer a $target-token summary goal below its $hardCap hard output cap',
    async ({ consumerLimit, outputLimit, target, hardCap }) => {
      const source = snapshot([
        '첫 약속.',
        '아직 풀리지 않은 의문.',
        '최근 첫 장면.',
        '최근 다음 장면.',
      ]);
      source.profile!.models.main = { ...model(), inputTokenLimit: consumerLimit };
      source.profile!.contextModel = {
        ...model('summary-model'),
        inputTokenLimit: 32768,
        maxOutputTokens: outputLimit,
      };
      source.contextPlan!.budget.inputTokenLimit = consumerLimit;
      const original = structuredClone(source),
        log = observed({ reason: 'manual' });
      // This fixed provider response exercises host policy, not semantic summary quality.
      vi.mocked(fetch).mockImplementation(async () => completed('SYNTHETIC_COMPLETE_SUMMARY'));
      const result = await prepareInputContext(source, log.hooks);
      expect(result.snapshot.contextPlan!.status).toBe('ready');
      expect(result.snapshot.contextPlan!.recentSourceRevisions).toEqual(['source-2', 'source-3']);
      expect(log.wires).toHaveLength(1);
      expect(log.wires[0].body).toMatchObject({
        generation: { maxOutputTokens: hardCap },
        input: { controls: { purpose: 'input-context-compaction', targetSummaryTokens: target } },
      });
      expect(source).toEqual(original);
      expect(result.snapshot.history).toEqual(original.history);
    }
  );

  test.each([0, -128])(
    'no summary is requested with %i estimated tokens free below the fixed-input trigger',
    async (freeTokens) => {
      const source = snapshot(['원문 하나.', '원문 둘.', '원문 셋.']),
        original = structuredClone(source),
        log = observed({
          measureInput: (projected) => ({
            snapshot: projected,
            estimatedInputTokens:
              8192 * 0.85 -
              freeTokens +
              projected.contextPlan!.recentSourceRevisions.length * 500 +
              (projected.contextPlan!.summary ? 20 : 0),
          }),
        });
      const error = await failure(prepareInputContext(source, log.hooks));
      expect(error.code).toBe('CONTEXT_FIXED_INPUT_TOO_LARGE');
      expect(error.usage.modelCalls).toBe(0);
      expect(log.wires).toHaveLength(0);
      expect(fetch).not.toHaveBeenCalled();
      expect(source).toEqual(original);
    }
  );

  test.each([
    { freeTokens: 128, summaryTokens: 20, fits: true },
    { freeTokens: 511, summaryTokens: 20, fits: true },
    { freeTokens: 128, summaryTokens: 129, fits: false },
    { freeTokens: 511, summaryTokens: 512, fits: false },
  ])(
    '$freeTokens tokens of summary headroom still require the actual $summaryTokens-token summary to pass final input admission',
    async ({ freeTokens, summaryTokens, fits }) => {
      const source = snapshot(['원문 하나.', '원문 둘.', '원문 셋.']),
        original = structuredClone(source),
        log = observed({
          measureInput: (projected) => ({
            snapshot: projected,
            estimatedInputTokens:
              8192 * 0.85 -
              freeTokens +
              projected.contextPlan!.recentSourceRevisions.length * 500 +
              (projected.contextPlan!.summary ? summaryTokens : 0),
          }),
        });
      vi.mocked(fetch).mockImplementation(async () => completed('SYNTHETIC_COMPLETE_SUMMARY'));
      if (fits) {
        const result = await prepareInputContext(source, log.hooks);
        expect(result.snapshot.contextPlan!.status).toBe('ready');
        expect(result.snapshot.contextPlan!.estimatedInputTokens).toBeLessThanOrEqual(8192 * 0.85);
      } else {
        const error = await failure(prepareInputContext(source, log.hooks));
        expect(error.code).toBe('CONTEXT_FIXED_INPUT_TOO_LARGE');
        expect(error.plan.estimatedInputTokens).toBeGreaterThan(8192 * 0.85);
      }
      expect(log.wires.length).toBeGreaterThan(0);
      for (const wire of log.wires)
        expect(wire.body).toMatchObject({
          generation: { maxOutputTokens: 4096 },
          input: { controls: { targetSummaryTokens: freeTokens } },
        });
      expect(source).toEqual(original);
    }
  );

  test('under-threshold input needs no provider call and preserves source text, roles, prompt, and current input', async () => {
    const source = snapshot(['미라는 부두에 도착했어요.']),
      original = structuredClone(source),
      log = observed();
    const result = await prepareInputContext(source, log.hooks);
    expect(result.usage).toEqual({ modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.snapshot.contextPlan).toMatchObject({
      status: 'ready',
      compacted: [],
      summary: null,
      summaryCalls: 0,
      error: null,
    });
    expect(source).toEqual(original);
    expect(result.snapshot.history).toEqual(original.history);
    expect(result.snapshot.logicalHistory).toEqual(original.logicalHistory);
    const body = JSON.stringify(buildMainProviderRequest(result.snapshot).request);
    expect(body).toContain(currentRequest);
    expect(body).toContain(fixedPrompt);
    expect(log.progress.at(-1)).toEqual(result.snapshot.contextPlan);
    expect(() => validateContextPlan(result.snapshot)).not.toThrow();
  });

  test('oversized Korean exchanges are summarized with user wishes intact before main generation, retaining the latest two exchanges', async () => {
    const source = snapshot(oldScenes()),
      original = structuredClone(source),
      log = observed(),
      payloads = respondWithMergedSummary(log);
    expect(
      measureMainContext(withContextProjection(source, [], null)).estimatedInputTokens
    ).toBeGreaterThan(8192 * 0.85);
    const result = await prepareInputContext(source, log.hooks),
      plan = result.snapshot.contextPlan!;
    expect(plan.status).toBe('ready');
    expect(plan.estimatedInputTokens).toBeLessThanOrEqual(8192 * 0.75);
    expect(plan.compacted.length).toBeGreaterThan(0);
    expect(plan.recentSourceRevisions).toEqual(expect.arrayContaining(['source-4', 'source-5']));
    const fragments = payloads.flatMap((payload) => payload.fragments);
    for (const ref of plan.compacted) {
      const messages = original.logicalHistory!.filter(
        (message) => message.sourceRevision === ref.revision
      );
      for (const message of messages)
        expect(
          fragments
            .filter((part) => part.messageId === message.id)
            .map((part) => part.text)
            .join('')
        ).toBe(message.text);
      expect(ref.hash).toBe(
        hash(original.history.find((item) => item.revision === ref.revision)!.text)
      );
    }
    const request = buildMainProviderRequest(result.snapshot).request,
      rendered = request
        .prompt!.messages.flatMap((message) => message.content.map((part) => part.text))
        .join('\n');
    expect(rendered).toContain(fixedPrompt);
    expect(rendered).toContain(currentRequest);
    expect(rendered).toContain(plan.summary);
    for (const ref of plan.compacted)
      expect(rendered).not.toContain(
        original.history.find((item) => item.revision === ref.revision)!.text
      );
    expect(result.usage).toEqual({
      modelCalls: payloads.length,
      inputTokens: 11 * payloads.length,
      outputTokens: 7 * payloads.length,
      costUsd: null,
    });
    expect(log.results).toHaveLength(payloads.length);
    expect(log.results.every((result) => result.opaqueState === null)).toBe(true);
    expect(log.wires.every((wire) => wire.role === 'context')).toBe(true);
    expect(source).toEqual(original);
    expect(result.snapshot.history).toEqual(original.history);
    expect(result.snapshot.logicalHistory).toEqual(original.logicalHistory);
    expect(() => validateContextPlan(result.snapshot)).not.toThrow();
  });

  test('a completed ancestor summary is reused without charging its earlier calls and is merged whole when new exchanges require more space', async () => {
    const first = snapshot(oldScenes()),
      initial = observed();
    respondWithMergedSummary(initial);
    const previous = (await prepareInputContext(first, initial.hooks)).snapshot.contextPlan!;
    vi.mocked(fetch).mockClear();
    const reuse = observed();
    const reused = await prepareInputContext(snapshot(oldScenes()), reuse.hooks, previous);
    expect(reused.usage.modelCalls).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(reused.snapshot.contextPlan!.summary).toBe(previous.summary);
    const expanded = snapshot([...oldScenes(), ...oldScenes().slice(0, 4)]),
      log = observed(),
      payloads = respondWithMergedSummary(log);
    const merged = await prepareInputContext(expanded, log.hooks, previous);
    expect(payloads[0].previousSummary).toBe(previous.summary);
    expect(merged.snapshot.contextPlan!.summary).toContain(previous.summary);
    expect(
      payloads
        .flatMap((payload) => payload.fragments)
        .some((part) => previous.compacted.some((ref) => ref.revision === part.sourceRevision))
    ).toBe(false);
    expect(merged.usage.modelCalls).toBe(payloads.length);
    expect(merged.snapshot.contextPlan!.compacted.slice(0, previous.compacted.length)).toEqual(
      previous.compacted
    );
    for (let i = 1; i < payloads.length; i++)
      expect(payloads[i].previousSummary).toContain(
        payloads[i - 1].previousSummary ?? '미라가 약속'
      );
  });

  test('successive compactions keep the same consumer policy and transmit the whole previous summary, exact source tuples, identifiers and correction notes', async () => {
    const sourceTexts = Array.from(
        { length: 10 },
        (_, index) =>
          `장면 ${index}: Darcy가 Elizabeth에게 한 발언이에요. 증언자는 Mira예요. CODE_${index}_Q7x-α9.`
      ),
      first = snapshot(sourceTexts.slice(0, 6)),
      correction =
        'USER_CORRECTION: 발언자는 Darcy, 대상은 Elizabeth예요. Mira의 코드는 Q7x-α9예요.';
    first.story = {
      config: defaultStoryConfig(),
      state: null,
      waiting: false,
      lineageHash: 'lineage',
      canonHash: 'canon-with-correction',
      notes: [
        {
          id: 'correction-note',
          chatId: first.chatId,
          atRevision: first.history[0].revision,
          atHash: first.history[0].contentHash!,
          text: correction,
          kind: 'author-note',
          declaration: { author: 'user', text: correction },
        },
      ],
      models: {},
    };
    const expanded = snapshot(sourceTexts);
    expanded.story = structuredClone(first.story);
    const originals = [structuredClone(first), structuredClone(expanded)],
      log = observed({ reason: 'manual' }),
      mergedSummary = 'FIXTURE_SUMMARY: Darcy → Elizabeth [scene 1]; witness=Mira; code=Q7x-α9.';
    // A canned response proves transmission and checkpoint invariants only, not fidelity of a model.
    vi.mocked(fetch).mockImplementation(async () => completed(mergedSummary));
    const initial = await prepareInputContext(first, log.hooks),
      previous = structuredClone(initial.snapshot.contextPlan!),
      next = await prepareInputContext(expanded, log.hooks, previous);
    expect(log.wires).toHaveLength(2);
    const payloads = log.wires.map((wire) => {
      expect(wire.body).toMatchObject({
        generation: { maxOutputTokens: 4096 },
        input: {
          controls: { targetSummaryTokens: 1024 },
          source: { userNotes: first.story!.notes },
        },
      });
      return (wire.body as { input: { source: SummaryPayload } }).input.source;
    });
    expect(payloads[0].previousSummary).toBeNull();
    expect(payloads[1].previousSummary).toBe(mergedSummary);
    for (const [index, fixed] of [first, expanded].entries()) {
      expect(payloads[index].sceneScope).toMatchObject({
        chatId: fixed.chatId,
        headRevision: fixed.history.at(-1)!.revision,
        headHash: fixed.history.at(-1)!.contentHash,
      });
      const contract = (log.wires[index].body as { stable: { contract: string } }).stable.contract;
      expect(contract).toContain('[scene 12]');
      expect(contract).toContain('Keep exact story identifiers and codes');
      expect(contract).toContain('Anchors share the existing summary budget');
    }
    const fragments = payloads.flatMap((payload) => payload.fragments);
    for (const ref of next.snapshot.contextPlan!.compacted) {
      for (const message of expanded.logicalHistory!.filter(
        (item) => item.sourceRevision === ref.revision
      )) {
        const transmitted = fragments.filter((part) => part.messageId === message.id);
        expect(transmitted.map((part) => part.text).join('')).toBe(message.text);
        expect(transmitted.every((part) => part.role === message.role)).toBe(true);
        expect(transmitted.every((part) => part.sourceHash === message.sourceHash)).toBe(true);
        expect(
          transmitted.every(
            (part) =>
              part.sourceSceneNumber ===
              expanded.history.findIndex((item) => item.revision === ref.revision) + 1
          )
        ).toBe(true);
      }
    }
    expect(
      payloads[1].fragments.some((part) =>
        previous.compacted.some((ref) => ref.revision === part.sourceRevision)
      )
    ).toBe(false);
    expect(initial.snapshot.contextPlan).toEqual(previous);
    expect([first, expanded]).toEqual(originals);
    expect(next.snapshot.history).toEqual(expanded.history);
    expect(next.snapshot.logicalHistory).toEqual(expanded.logicalHistory);
  });

  test('one large source is split on UTF-16 boundaries and becomes compacted only after all user and assistant fragments succeed', async () => {
    const text = `LARGE_SOURCE_START\n${'🌙 미라가 천천히 항구의 진실을 살펴봐요.\n'.repeat(1500)}LARGE_SOURCE_END`;
    const source = snapshot([text]),
      log = observed(),
      payloads = respondWithMergedSummary(log);
    const result = await prepareInputContext(source, log.hooks),
      parts = payloads.flatMap((payload) => payload.fragments);
    expect(payloads.length).toBeGreaterThan(2);
    expect(result.snapshot.contextPlan!.compacted).toEqual([
      { revision: 'source-0', hash: hash(text) },
    ]);
    expect(result.snapshot.contextPlan!.recentSourceRevisions).toEqual([]);
    for (const message of source.logicalHistory!) {
      const fragments = parts.filter((part) => part.messageId === message.id);
      let offset = 0;
      for (const part of fragments) {
        expect(part.offsetUtf16).toBe(offset);
        expect(part.totalUtf16).toBe(message.text.length);
        expect(part.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
        offset += part.text.length;
      }
      expect(fragments.map((part) => part.text).join('')).toBe(message.text);
    }
    for (const plan of log.progress.filter(
      (plan) => plan.summaryCalls > 0 && plan.summaryCalls < payloads.length
    ))
      expect(plan).toMatchObject({ compacted: [], summary: null });
    expect(log.wires.every((wire) => wire.role === 'context')).toBe(true);
    expect(source.history[0].text).toBe(text);
  });

  test('an explicitly authored start can be compacted as one assistant message without inventing a user turn or leaking its host discriminator', async () => {
    const text = `AUTHORED_START\n${paragraph.repeat(450)}`,
      source = snapshot([text]);
    const authored: PromptHistoryMessage = {
      ...source.logicalHistory![1],
      runId: 'authored-start-run',
      sourceKind: 'authored-start',
    };
    source.logicalHistory = [authored];
    const original = structuredClone(source),
      log = observed(),
      payloads = respondWithMergedSummary(log);
    const initial = measureMainContext(withContextProjection(source, [], null)).snapshot;
    const request = buildMainProviderRequest(initial).request;
    const message = request.prompt!.messages.find(
      (item) => item.provenance.sourceRevision === 'source-0'
    )!;
    expect(message.role).toBe('assistant');
    expect(message.provenance).toEqual({
      blockId: 'history',
      origin: 'history',
      sourceRevision: 'source-0',
      sourceHash: hash(text),
      runId: 'authored-start-run',
    });
    expect(() => validateProviderPrompt(request.prompt)).not.toThrow();
    expect(JSON.stringify(request)).not.toContain('sourceKind');
    const result = await prepareInputContext(source, log.hooks),
      fragments = payloads.flatMap((payload) => payload.fragments);
    expect(result.snapshot.contextPlan).toMatchObject({
      status: 'ready',
      compacted: [{ revision: 'source-0', hash: hash(text) }],
    });
    expect(payloads.length).toBeGreaterThan(0);
    expect(
      fragments.every((part) => part.role === 'assistant' && part.messageId === authored.id)
    ).toBe(true);
    expect(fragments.map((part) => part.text).join('')).toBe(text);
    expect(result.snapshot.logicalHistory).toEqual([authored]);
    expect(source).toEqual(original);
    expect(JSON.stringify(log.wires)).not.toContain('sourceKind');
  });

  test('an authored-start discriminator is invalid on user/current messages or an ordinary pair, and unknown discriminators are rejected', async () => {
    const valid: PromptHistoryMessage = {
      id: 'authored',
      role: 'assistant',
      text: 'A directly authored start.',
      sourceRevision: 'source',
      sourceHash: 'a'.repeat(64),
      runId: 'run',
      sourceKind: 'authored-start',
    };
    for (const changed of [
      { ...valid, role: 'user' },
      { ...valid, current: true },
      { ...valid, sourceKind: 'generated' },
    ]) {
      expect(() =>
        compilePromptProgram(
          {
            version: 1,
            controls: [],
            blocks: [{ id: 'history', title: 'History', kind: 'history', from: 0, to: 'end' }],
          },
          { slots: {}, history: [changed as PromptHistoryMessage] }
        )
      ).toThrow('PROMPT_INVALID_HISTORY_SOURCE');
    }
    const paired = snapshot(oldScenes());
    paired.logicalHistory![1].sourceKind = 'authored-start';
    expect(await failure(prepareInputContext(paired, observed().hooks))).toMatchObject({
      code: 'CONTEXT_LOGICAL_PAIR_MISSING',
      usage: { modelCalls: 0 },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('configured source exclusions are applied before summarization while compacted references hash the full original source', async () => {
    const source = snapshot(
      oldScenes().map(
        (text) => `${text}\n@hsTitle: Private\nHIDDEN_SOURCE_CANARY\n@hs\nVisible ending.`
      )
    );
    source.sourceSegments = createSourceSegmentFixture({ excludeAsides: true });
    const seeded = seedContextPlan(source),
      log = observed(),
      payloads = respondWithMergedSummary(log);
    const result = await prepareInputContext(seeded, log.hooks),
      encoded = JSON.stringify(payloads);
    expect(encoded).not.toContain('HIDDEN_SOURCE_CANARY');
    expect(JSON.stringify(seeded.history)).toContain('HIDDEN_SOURCE_CANARY');
    const allowed = sourceLogicalHistoryForRequest(seeded, seeded.logicalHistory!);
    for (const ref of result.snapshot.contextPlan!.compacted) {
      expect(ref.hash).toBe(
        hash(seeded.history.find((item) => item.revision === ref.revision)!.text)
      );
      for (const message of allowed.filter((message) => message.sourceRevision === ref.revision))
        expect(
          payloads
            .flatMap((payload) => payload.fragments)
            .filter((part) => part.messageId === message.id)
            .map((part) => part.text)
            .join('')
        ).toBe(message.text);
    }
  });

  test('a checkpoint containing a formerly allowed report cannot be reused after its configured retention window expires', async () => {
    const text = `${paragraph.repeat(400)}<EvaluationReport><RevisionReport>[82]<DevelopmentReport>REPORT_EXPIRY_CANARY</EvaluationReport>`;
    const source = snapshot([text]);
    source.sourceSegments = createSourceSegmentFixture({
      excludeAnnotations: false,
      keepLastMessages: 5,
    });
    const earlier = seedContextPlan(source),
      log = observed(),
      payloads = respondWithMergedSummary(log);
    const previous = (await prepareInputContext(earlier, log.hooks)).snapshot.contextPlan!;
    expect(previous.compacted).toHaveLength(1);
    expect(JSON.stringify(payloads)).toContain('REPORT_EXPIRY_CANARY');
    const next = snapshot([text, '새 장면 1.', '새 장면 2.', '새 장면 3.']);
    next.sourceSegments = structuredClone(source.sourceSegments);
    const later = seedContextPlan(next),
      laterRefs = contextSourceRefs(later);
    expect(laterRefs[0].hash).toBe(previous.compacted[0].hash);
    expect(laterRefs[0].viewHash).not.toBe(previous.compacted[0].viewHash);
    vi.mocked(fetch).mockClear();
    const error = await failure(prepareInputContext(later, observed().hooks, previous));
    expect(error.code).toBe('CONTEXT_CHECKPOINT_INVALID');
    expect(error.usage.modelCalls).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(
      JSON.stringify(sourceLogicalHistoryForRequest(later, later.logicalHistory!))
    ).not.toContain('REPORT_EXPIRY_CANARY');
  });

  test.each([
    [
      'refused',
      () =>
        sse({ type: 'refusal', message: 'Synthetic refusal' }, { type: 'done', reason: 'refusal' }),
      'CONTEXT_COMPACTION_REFUSED',
    ],
    [
      'partial',
      () => sse({ type: 'text_delta', delta: 'Unfinished summary' }),
      'CONTEXT_COMPACTION_PARTIAL',
    ],
    ['empty', () => sse({ type: 'done', reason: 'stop' }), 'CONTEXT_COMPACTION_EMPTY'],
    [
      'error',
      () => new Response('PRIVATE_ERROR_BODY', { status: 503 }),
      'CONTEXT_COMPACTION_PROVIDER_ERROR',
    ],
    [
      'tool call',
      () =>
        sse(
          { type: 'tool_delta', index: 0, id: 'bad', name: 'story.read', argumentsDelta: '{}' },
          { type: 'done', reason: 'tool_calls' }
        ),
      'CONTEXT_COMPACTION_UNEXPECTED_TOOLS',
    ],
  ] as const)(
    '%s is terminal, retains uncertainty and cannot start main or silently drop source text',
    async (_label, response, code) => {
      const source = snapshot(oldScenes()),
        log = observed();
      vi.mocked(fetch).mockResolvedValueOnce(response());
      const error = await failure(prepareInputContext(source, log.hooks));
      expect(error.code).toBe(code);
      expect(error.usage).toEqual({
        modelCalls: 1,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
      });
      expect(error.plan).toMatchObject({
        status: 'failed',
        compacted: [],
        summary: null,
        summaryCalls: 1,
        error: code,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(log.wires.map((wire) => wire.role)).toEqual(['context']);
      expect(log.results).toHaveLength(1);
      expect(JSON.stringify(error.plan)).not.toContain('PRIVATE_ERROR_BODY');
      expect(log.progress.at(-1)).toEqual(error.plan);
      expect(source.contextPlan!.status).toBe('pending');
    }
  );

  test('partial failure after a successful large-source fragment never marks the source or the staged summary reusable', async () => {
    const source = snapshot([paragraph.repeat(1200)]),
      log = observed();
    vi.mocked(fetch)
      .mockResolvedValueOnce(completed('PARTIAL_SOURCE_SUMMARY'))
      .mockResolvedValueOnce(sse({ type: 'text_delta', delta: 'Unfinished' }));
    const error = await failure(prepareInputContext(source, log.hooks));
    expect(error.code).toBe('CONTEXT_COMPACTION_PARTIAL');
    expect(error.plan).toMatchObject({ compacted: [], summary: null, summaryCalls: 2 });
    expect(error.usage).toEqual({
      modelCalls: 2,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((log.wires[1].body as any).input.source.previousSummary).toBe('PARTIAL_SOURCE_SUMMARY');
    expect(source.history[0].text).toBe(paragraph.repeat(1200));
  });

  test('cancellation before or at durable attempt start makes no send, retains the admitted attempt, and never exposes the abort reason', async () => {
    const controller = new AbortController();
    controller.abort('SENSITIVE_ABORT_REASON');
    const before = observed({ signal: controller.signal });
    expect(await failure(prepareInputContext(snapshot(oldScenes()), before.hooks))).toMatchObject({
      code: 'CANCELLED',
      usage: { modelCalls: 0 },
    });
    expect(fetch).not.toHaveBeenCalled();
    const during = new AbortController(),
      log = observed({ signal: during.signal });
    const start = log.hooks.onAttemptStart;
    log.hooks.onAttemptStart = async (wire) => {
      const id = await start(wire);
      during.abort('SENSITIVE_ABORT_REASON');
      return id;
    };
    const error = await failure(prepareInputContext(snapshot(oldScenes()), log.hooks));
    expect(error.code).toBe('CANCELLED');
    expect(error.usage.modelCalls).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(log.results).toHaveLength(1);
    expect(JSON.stringify({ plan: error.plan, results: log.results })).not.toContain(
      'SENSITIVE_ABORT_REASON'
    );
    const saving = new AbortController(),
      checkpoint = observed({
        signal: saving.signal,
        onProgress: () => {
          saving.abort('PRIVATE_SAVE_ABORT');
        },
      });
    expect(
      await failure(prepareInputContext(snapshot(['짧은 장면.']), checkpoint.hooks))
    ).toMatchObject({ code: 'CANCELLED', usage: { modelCalls: 0 } });
  });

  test('one main call remains reserved and a fixed input that cannot fit fails before any summary provider request', async () => {
    const source = snapshot(oldScenes());
    source.settings.maxCalls = 1;
    const budget = observed();
    expect(await failure(prepareInputContext(source, budget.hooks))).toMatchObject({
      code: 'CONTEXT_COMPACTION_CALL_LIMIT',
      usage: { modelCalls: 0 },
    });
    const fixed = snapshot([]);
    fixed.request = paragraph.repeat(1500);
    const log = observed();
    const error = await failure(prepareInputContext(fixed, log.hooks));
    expect(error.code).toBe('CONTEXT_FIXED_INPUT_TOO_LARGE');
    expect(error.usage.modelCalls).toBe(0);
    expect(
      error.plan.estimatedInputTokens === null || Number.isFinite(error.plan.estimatedInputTokens)
    ).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    const unmeasurable = observed({
      measureInput: (value) => ({ snapshot: value, estimatedInputTokens: Infinity }),
    });
    expect(await failure(prepareInputContext(snapshot([]), unmeasurable.hooks))).toMatchObject({
      code: 'CONTEXT_FIXED_INPUT_TOO_LARGE',
      plan: { estimatedInputTokens: null },
    });
    const invalid = observed({
      measureInput: () => {
        throw new Error('PROMPT_UNSUPPORTED_MODEL');
      },
    });
    expect(await failure(prepareInputContext(snapshot([]), invalid.hooks))).toMatchObject({
      code: 'PROMPT_UNSUPPORTED_MODEL',
      usage: { modelCalls: 0 },
    });
  });

  test('the frozen memory model is preferred and known accounting is accumulated without modifying either model', async () => {
    const source = snapshot(oldScenes()),
      memory = model('memory-model');
    source.story = {
      config: defaultStoryConfig(),
      state: null,
      waiting: false,
      lineageHash: 'lineage',
      canonHash: 'canon',
      notes: [],
      models: { context: memory },
    };
    source.profile!.contextModel = memory;
    const original = structuredClone(source),
      log = observed();
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      const wire = JSON.parse(String(options?.body));
      expect(wire.modelId).toBe(memory.modelId);
      return completed('미라는 약속을 기억하고 진실은 미확인 상태예요.', 0.02);
    });
    const result = await prepareInputContext(source, log.hooks);
    expect(result.usage.modelCalls).toBeGreaterThan(0);
    expect(result.usage.costUsd).toBeCloseTo(result.usage.modelCalls * 0.02);
    expect(source).toEqual(original);
    expect(
      log.wires.every(
        (wire) => wire.modelId === memory.modelId && wire.connectionId === memory.connectionId
      )
    ).toBe(true);
  });

  test('an auxiliary caller can measure its own source envelope and choose a summary model without a main model', async () => {
    const source = snapshot(oldScenes()),
      auxiliary = model('auxiliary-summary');
    delete source.profile!.models.main;
    const original = structuredClone(source),
      measurements: RunSnapshot[] = [];
    const log = observed({
      summaryModel: auxiliary,
      measureInput: (projected) => {
        measurements.push(structuredClone(projected));
        const kept = new Set(projected.contextPlan!.recentSourceRevisions);
        return {
          snapshot: projected,
          estimatedInputTokens: estimateContextTokens({
            fixed: 'AUXILIARY_FIXED_SOURCE',
            currentInput: projected.request,
            summary: projected.contextPlan!.summary,
            history: projected.logicalHistory!.filter((message) =>
              kept.has(message.sourceRevision!)
            ),
          }),
        };
      },
    });
    const payloads = respondWithMergedSummary(log),
      result = await prepareInputContext(source, log.hooks);
    expect(payloads.length).toBeGreaterThan(0);
    expect(measurements.length).toBeGreaterThan(2);
    expect(result.snapshot.contextPlan!.status).toBe('ready');
    expect(
      log.wires.every(
        (wire) => wire.modelId === auxiliary.modelId && wire.connectionId === auxiliary.connectionId
      )
    ).toBe(true);
    expect(result.snapshot.request).toBe(currentRequest);
    expect(result.snapshot.history).toEqual(original.history);
    expect(source).toEqual(original);
  });

  test('hash corruption, missing logical roles, revoked authority, and failed attempt persistence stop before transmission', async () => {
    const poisoned = snapshot(oldScenes());
    poisoned.history[0].contentHash = 'b'.repeat(64);
    expect(await failure(prepareInputContext(poisoned, observed().hooks))).toMatchObject({
      code: 'CONTEXT_SOURCE_HASH_MISMATCH',
      usage: { modelCalls: 0 },
    });
    const missing = snapshot(oldScenes());
    missing.logicalHistory = missing.logicalHistory!.filter((message) => message.role !== 'user');
    expect(await failure(prepareInputContext(missing, observed().hooks))).toMatchObject({
      code: 'CONTEXT_LOGICAL_PAIR_MISSING',
      usage: { modelCalls: 0 },
    });
    expect(
      await failure(
        prepareInputContext(
          snapshot(oldScenes()),
          observed({ authorize: (connection) => ({ ...connection, enabled: false }) }).hooks
        )
      )
    ).toMatchObject({ code: 'CONNECTION_NOT_AUTHORIZED', usage: { modelCalls: 0 } });
    const unsaved = observed({
      onAttemptStart: () => {
        throw new Error('SENSITIVE_STORAGE_ERROR');
      },
    });
    expect(await failure(prepareInputContext(snapshot(oldScenes()), unsaved.hooks))).toMatchObject({
      code: 'CONTEXT_ATTEMPT_START_FAILED',
      usage: { modelCalls: 0 },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(unsaved.results).toEqual([]);
  });
});
