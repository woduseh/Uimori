import { describe, expect, it, vi } from 'vitest';
import { defaultProfile } from '../core/product.js';
import { DEFAULT_LORE_CONTEXT, type LoreContextPolicy } from '../core/lore-context.js';
import { countTextTokens } from '../core/text-tokens.js';
import type { RunSnapshot } from '../core/types.js';
import type { MainHooks } from '../server/model-runner.js';
import { prepareLoreSelection } from '../server/lore-selection.js';

const text = 'The harbor is open. 항구의 문이 열려 있다. 日本語も含む。';

async function selectedSnapshot(attachments = 1, limit?: (policy: LoreContextPolicy) => void) {
  const policy: LoreContextPolicy = {
    ...DEFAULT_LORE_CONTEXT,
    judgment: { ...DEFAULT_LORE_CONTEXT.judgment },
  };
  limit?.(policy);
  const snapshot: RunSnapshot = {
    chatId: 'token-selection',
    parentRevision: null,
    settingsRevision: 1,
    settings: { status: false, maxCalls: 4 },
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
        lore: [{ id: 'harbor', title: 'Harbor', description: '', text, loading: 'discoverable' }],
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
  const result = await prepareLoreSelection(snapshot, hooks, {
    reserveCalls: 1,
    jev: { credential: () => 'synthetic-test-key', fetch: send },
  });
  expect(send).toHaveBeenCalledTimes(1);
  if (!limit)
    expect(result.snapshot.loreSelection!.entries.map((entry) => entry.selected)).toEqual(
      Array.from({ length: attachments }, () => ['harbor'])
    );
  return { snapshot: result.snapshot, send };
}

describe('local-token selection receipt accounting', () => {
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
