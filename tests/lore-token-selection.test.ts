import { describe, expect, it, vi } from 'vitest';
import { defaultProfile } from '../core/product.js';
import { DEFAULT_LORE_CONTEXT, type LoreContextPolicy } from '../core/lore-context.js';
import { countTextTokens } from '../core/text-tokens.js';
import type { RisuLoreProjection } from '../core/risu-content.js';
import { compiledPackages } from '../core/package-context.js';
import type { RunSnapshot } from '../core/types.js';
import type { MainHooks } from '../server/model-runner.js';
import { prepareLoreSelection } from '../server/lore-selection.js';

const text = 'The harbor is open. 항구의 문이 열려 있다. 日本語も含む。';

async function selectedSnapshot(
  attachments = 1,
  limit?: (policy: LoreContextPolicy) => void,
  lore: RisuLoreProjection[] = [
    { id: 'harbor', title: 'Harbor', description: '', text, loading: 'discoverable' },
  ]
) {
  const policy: LoreContextPolicy = {
    ...DEFAULT_LORE_CONTEXT,
    judgment: { ...DEFAULT_LORE_CONTEXT.judgment },
  };
  limit?.(policy);
  const snapshot: RunSnapshot = {
    chatId: 'token-selection',
    parentRevision: null,
    settingsRevision: 1,
    settings: { maxCalls: 4 },
    request: 'Visit the harbor',
    history: [],
    resources: [],
    profile: {
      ...defaultProfile('token-selection'),
      models: {},
      loreContext: policy,
      packageAttachments: Array.from({ length: attachments }, (_, index) => ({
        id: `package-${index}`,
        revision: 1,
        role: index === 0 ? ('bot' as const) : ('module' as const),
      })),
      packages: Array.from({ length: attachments }, (_, index) => ({
        version: 2,
        id: `package-${index}`,
        revision: 1,
        title: `Package ${index}`,
        description: '',
        loreActivation: { mode: 'model' },
        nativeRisu: { version: 1, card: {}, assets: [], sourceHash: 'a'.repeat(64) },
        lore: structuredClone(lore),
      })),
    },
  };
  const hooks: MainHooks = {
    signal: new AbortController().signal,

    authorize: () => {
      throw new Error('No generative provider may run in this test');
    },
    onInput: vi.fn(),
    onToolEvent: vi.fn(),
    onAttemptStart: vi.fn(() => 'local-test-attempt'),
    onAttemptFinish: vi.fn(),
  };
  // Only the JEV HTTP boundary is synthetic. The actual tokenizer and request/selection code run.
  const send = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        model: 'jev-latest',
        answers: Object.fromEntries(
          Object.keys(body.questions).map((key) => [key, { type: 'noul', noul: 0.9 }])
        ),
        usage: { input_tokens: 100, output_tokens: 5 },
      }),
      { status: 200 }
    );
  });
  const original = structuredClone(snapshot);
  const result = await prepareLoreSelection(snapshot, hooks, {
    reserveCalls: 1,
    jev: { credential: () => 'synthetic-test-key', fetch: send },
  });
  if (!limit)
    expect(result.snapshot.loreSelection!.entries.map((entry) => entry.selected)).toEqual(
      Array.from({ length: attachments }, () => ['harbor'])
    );
  expect(snapshot).toEqual(original);
  return { snapshot: result.snapshot, send, usage: result.usage, hooks };
}

describe('local-token selection receipt accounting', () => {
  it('omits individually oversized lore before judging later entries in authored order across packages', async () => {
    const lore: RisuLoreProjection[] = [
      {
        id: 'oversized',
        title: 'Too large',
        description: '',
        text: text.repeat(500),
        loading: 'discoverable',
      },
      { id: 'harbor', title: 'Harbor', description: '', text, loading: 'discoverable' },
      {
        id: 'promise',
        title: 'Promise',
        description: '',
        text: 'Mira promised to return.',
        loading: 'discoverable',
      },
    ];
    const { snapshot, send, usage } = await selectedSnapshot(
      2,
      (policy) => {
        policy.maxRetainedTokens = 200;
        policy.judgment.maxSelectedTokens = 200;
        policy.judgment.maxInputTokens = 1000;
      },
      lore
    );
    expect(send).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(send.mock.calls[0][1]?.body));
    expect(body.state.entries).toEqual([
      { id: 'entry_0_1', title: 'Package 0: Harbor', text },
      { id: 'entry_0_2', title: 'Package 0: Promise', text: lore[2].text },
      { id: 'entry_1_1', title: 'Package 1: Harbor', text },
      { id: 'entry_1_2', title: 'Package 1: Promise', text: lore[2].text },
    ]);
    for (const entry of snapshot.loreSelection!.entries) {
      expect(entry.selected).toEqual(['harbor', 'promise']);
      expect(entry.omitted).toEqual([{ id: 'oversized', reason: 'budget' }]);
      expect(entry.judgment!.scores.map((score) => score.id)).toEqual(['harbor', 'promise']);
    }
    for (const pkg of compiledPackages(snapshot, 'main'))
      expect(pkg.resources.map((resource) => resource.loading)).toEqual([
        'discoverable',
        'pinned',
        'pinned',
      ]);
    expect(usage.modelCalls).toBe(1);
  });

  it.each(['retention', 'selection', 'entries'] as const)(
    'makes no judgment call when every candidate exceeds the %s allowance',
    async (kind) => {
      const { snapshot, send, usage, hooks } = await selectedSnapshot(2, (policy) => {
        if (kind === 'retention') policy.maxRetainedTokens = countTextTokens(text) - 1;
        if (kind === 'selection') policy.judgment.maxSelectedTokens = 0;
        if (kind === 'entries') policy.maxRetainedEntries = 0;
      });
      expect(send).not.toHaveBeenCalled();
      expect(hooks.onAttemptStart).not.toHaveBeenCalled();
      expect(usage).toEqual({ modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
      for (const entry of snapshot.loreSelection!.entries) {
        expect(entry.selected).toEqual([]);
        expect(entry.omitted).toEqual([{ id: 'harbor', reason: 'budget' }]);
        expect(entry).not.toHaveProperty('error');
        expect(entry).not.toHaveProperty('judgment');
      }
    }
  );

  it('records selected-text token counts from one judgment request', async () => {
    const { snapshot, send } = await selectedSnapshot(2);
    expect(snapshot.loreSelection!.entries.map((entry) => entry.judgment!.selectedTokens)).toEqual([
      countTextTokens(text),
      countTextTokens(text),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['retention', 'selection', 'entries'] as const)(
    'the real selector respects the shared %s budget across packages',
    async (kind) => {
      const { snapshot, send } = await selectedSnapshot(2, (policy) => {
        if (kind === 'retention') policy.maxRetainedTokens = countTextTokens(text);
        if (kind === 'selection') policy.judgment.maxSelectedTokens = countTextTokens(text);
        if (kind === 'entries') policy.maxRetainedEntries = 1;
      });
      const entries = snapshot.loreSelection!.entries;
      expect(entries.flatMap((entry) => entry.selected)).toHaveLength(1);
      expect(entries.reduce((sum, entry) => sum + (entry.judgment?.selectedTokens ?? 0), 0)).toBe(
        countTextTokens(text)
      );
      expect(send).toHaveBeenCalledTimes(1);
    }
  );
});
