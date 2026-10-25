import { expect, test, vi } from 'vitest';
import { defaultProfile } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import type { MainHooks } from '../server/model-runner.js';
import { prepareLoreSelection } from '../server/lore-selection.js';
import { projectLoreSelectionReceipt } from '../core/lore-selection.js';
import { countTextTokens } from '../core/text-tokens.js';
import { DEFAULT_LORE_CONTEXT } from '../core/lore-context.js';
import { compileRisuPrompt } from '../core/risu-prompt.js';
import { nativePrompt } from './fixtures/native-prompt.js';
import { contextBudgetForModel } from '../core/context-budget.js';
const sentEntries = (body: {
  questions: Record<
    string,
    { instructions: { entry: { id: string; title: string; text: string; description?: string } } }
  >;
}) => Object.values(body.questions).map((question) => question.instructions.entry);

const snapshot = (): RunSnapshot => ({
  chatId: 'lore-test',
  parentRevision: null,
  settingsRevision: 1,
  settings: { maxCalls: 2 },
  request: 'Visit the harbor',
  history: [],
  resources: [],
  profile: {
    ...defaultProfile('lore-test'),
    models: {},
    packageAttachments: [{ id: 'card', revision: 1, role: 'bot' }],
    packages: [
      {
        version: 2,
        id: 'card',
        revision: 1,
        title: 'Card',
        description: '',
        nativeRisu: { version: 1, card: {}, assets: [], sourceHash: 'a'.repeat(64) },
        loreActivation: { mode: 'model' },
        lore: [
          {
            id: 'harbor',
            title: 'Harbor',
            description: '',
            text: 'The harbor is open.',
            loading: 'discoverable',
          },
        ],
      },
    ],
  },
});
const hooks = (): MainHooks => ({
  signal: new AbortController().signal,

  authorize: vi.fn(() => {
    throw new Error('Generative fallback forbidden');
  }),
  onInput: vi.fn(),
  onToolEvent: vi.fn(),
  onAttemptStart: vi.fn(() => 'attempt'),
  onAttemptFinish: vi.fn(),
});
test('token budgets preserve long requests and catalogs without character-based cuts', async () => {
  const input = snapshot();
  input.request = 'Continue. '.repeat(600) + 'Respect the final direction.';
  input.profile!.loreContext = {
    ...DEFAULT_LORE_CONTEXT,
    maxRetainedTokens: 100_000,
    judgment: {
      ...DEFAULT_LORE_CONTEXT.judgment,
      maxSelectedTokens: 100_000,
      maxInputTokens: 30_000,
    },
  };
  input.profile!.packages![0].lore[0].text = 'a'.repeat(200_001);
  input.history = [{ revision: 'past', text: '기억할 장면 😀 '.repeat(2000) + '마지막 단서' }];
  const send = vi.fn(
    async (_url: unknown, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          model: 'jev-latest',
          answers: { entry_0: { type: 'noul', noul: 0.9 } },
          usage: { input_tokens: 100, output_tokens: 5 },
        })
      )
  );
  const result = await prepareLoreSelection(input, hooks(), {
    reserveCalls: 1,
    jev: { credential: () => 'synthetic-key', fetch: send },
  });
  expect(send).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(send.mock.calls[0][1]!.body));
  expect(body.state.request).toBe(input.request);
  expect(sentEntries(body)[0].text).toBe(input.profile!.packages![0].lore[0].text);
  expect(body.state.conversation[0].truncated).toBe(true);
  expect(body.state.conversation[0].text.endsWith('마지막 단서')).toBe(true);
  expect(countTextTokens(body.state.conversation[0].text)).toBeLessThanOrEqual(500);
  expect(result.usage.modelCalls).toBe(1);
  expect(result.snapshot.loreSelection!.entries[0].error).toBeUndefined();
});
test('reserves the writer call and never substitutes the context model', async () => {
  const input = snapshot();
  input.settings.maxCalls = 1;
  const h = hooks(),
    fetch = vi.fn();
  const result = await prepareLoreSelection(input, h, {
    reserveCalls: 1,
    jev: { credential: () => 'key', fetch },
  });
  expect(result.usage.modelCalls).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
  expect(h.authorize).not.toHaveBeenCalled();
  expect(result.snapshot.loreSelection!.entries[0].error).toBe('LORE_SELECTION_CALL_LIMIT');
});
test('missing JEV credentials retain tool-discoverable lore with a failure receipt', async () => {
  const input = snapshot(),
    h = hooks(),
    fetch = vi.fn();
  const result = await prepareLoreSelection(input, h, {
    reserveCalls: 1,
    jev: { credential: () => undefined, fetch },
  });
  expect(result.snapshot.loreSelection!.entries[0]).toMatchObject({
    error: 'JEV_CREDENTIAL_REQUIRED',
    selected: [],
  });
  expect(projectLoreSelectionReceipt(result.snapshot.loreSelection!, 'card@1:bot')).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
  expect(h.authorize).not.toHaveBeenCalled();
  expect(result.usage.modelCalls).toBe(0);
});
test('an uncertain paid attempt is recorded once and replay never repeats it', async () => {
  const h = hooks(),
    fetch = vi.fn(async () => {
      throw new Error('connection lost');
    });
  const options = { reserveCalls: 1, jev: { credential: () => 'key', fetch } };
  const first = await prepareLoreSelection(snapshot(), h, options);
  expect(first.usage.modelCalls).toBe(1);
  expect(first.usage.inputTokens).toBeNull();
  expect(first.snapshot.loreSelection!.entries[0].error).toBe('JEV_EXECUTION_FAILED');
  const replay = await prepareLoreSelection(first.snapshot, h, options);
  expect(replay.snapshot).toEqual(first.snapshot);
  expect(replay.usage.modelCalls).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(h.onAttemptFinish).toHaveBeenCalledTimes(1);
  expect(h.authorize).not.toHaveBeenCalled();
});
test('authored openings and tool-only lore never trigger relevance judgments', async () => {
  const input = snapshot();
  input.profile!.packages![0].loreActivation = { mode: 'discoverable' };
  const h = hooks(),
    fetch = vi.fn();
  const result = await prepareLoreSelection(input, h, {
    reserveCalls: 1,
    jev: { credential: () => 'key', fetch },
  });
  expect(result.snapshot.loreSelection).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});
test('turn references are inserted after native negative chat slices and cache anchors resolve', () => {
  const program = nativePrompt('', {
    promptTemplate: [
      { type: 'chat', rangeStart: 0, rangeEnd: -2 },
      { type: 'cache' },
      { type: 'plain', role: 'system', text: 'TAIL_SYSTEM' },
      { type: 'chat', rangeStart: -2, rangeEnd: 'end' },
    ],
  });
  const history = [
    { id: 'request:old', role: 'user' as const, text: 'OLD_REQUEST' },
    { id: 'source:old', role: 'assistant' as const, text: 'OLD_REPLY' },
    { id: 'current-input', role: 'user' as const, text: 'CURRENT_REQUEST', current: true },
  ];
  const baseline = compileRisuPrompt(program, { history, slots: {} });
  const actual = compileRisuPrompt(program, {
    history,
    slots: {},
    references: [
      {
        message: { id: 'lore-reference:old', role: 'user', text: 'OLD_REFERENCE' },
        beforeMessageId: 'request:old',
      },
      {
        message: { id: 'lore-reference:current', role: 'user', text: 'CURRENT_REFERENCE' },
        beforeMessageId: 'current-input',
      },
    ],
  });
  expect(actual.messages.filter((message) => !message.id.startsWith('lore-reference:'))).toEqual(
    baseline.messages
  );
  expect(actual.cachePlan).toEqual(baseline.cachePlan);
  expect(actual.messages.map((message) => (message.content[0] as { text: string }).text)).toEqual([
    'OLD_REFERENCE',
    'OLD_REQUEST',
    'TAIL_SYSTEM',
    'OLD_REPLY',
    'CURRENT_REFERENCE',
    'CURRENT_REQUEST',
  ]);
});
test('judgment uses the finalized derived summary and visible recent turns without another summary call', async () => {
  let input = snapshot();
  input.history = [
    { revision: 'old', text: 'COMPACTED_CANARY' },
    { revision: 'recent', text: 'RECENT_CANARY' },
  ];
  // Reuse the established context-plan shape; JEV consumes it as reference data.
  input = {
    ...input,
    contextPlan: {
      version: 1,
      status: 'ready',
      dependencyKey: '',
      budget: contextBudgetForModel({ modelId: 'fixture' }),
      compacted: [{ revision: 'old', hash: 'a'.repeat(64) }],
      recentSourceRevisions: ['recent'],
      summary: 'EARLIER_HARBOR_FACT',
      estimatedInputTokens: 100,
      summaryCalls: 0,
      usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      error: null,
    },
  };
  const send = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const { state } = JSON.parse(String(init?.body));
    expect(state.summary).toEqual({
      kind: 'derived-conversation-summary',
      text: 'EARLIER_HARBOR_FACT',
    });
    expect(state.conversation.map((message: { text: string }) => message.text)).toEqual([
      'RECENT_CANARY',
    ]);
    return new Response(
      JSON.stringify({
        model: 'jev-latest',
        answers: { entry_0: { type: 'noul', noul: 0.99 } },
        usage: { input_tokens: 10, output_tokens: 1 },
      })
    );
  });
  const result = await prepareLoreSelection(input, hooks(), {
    reserveCalls: 1,
    jev: { credential: () => 'synthetic', fetch: send },
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(result.usage.modelCalls).toBe(1);
  expect(result.snapshot.loreSelection!.entries[0].selected).toEqual(['harbor']);
});
