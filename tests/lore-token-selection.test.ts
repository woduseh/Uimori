import { describe, expect, it, vi } from 'vitest';
import { defaultProfile } from '../core/product.js';
import { DEFAULT_LORE_CONTEXT, type LoreContextPolicy } from '../core/lore-context.js';
import { countTextTokens } from '../core/text-tokens.js';
import { validateLoreSelectionReceipt } from '../core/lore-selection.js';
import type { RunSnapshot } from '../core/types.js';
import type { MainHooks } from '../server/model-runner.js';
import {
  loreSelectionTargets,
  prepareLoreSelection,
  validateLoreSelectionTokenBudgets,
} from '../server/lore-selection.js';

const text = 'The harbor is open. 항구의 문이 열려 있다. 日本語も含む。';

async function selectedSnapshot(attachments = 1) {
  const policy: LoreContextPolicy = {
    ...DEFAULT_LORE_CONTEXT,
    judgment: { ...DEFAULT_LORE_CONTEXT.judgment },
  };
  const snapshot: RunSnapshot = {
    chatId: 'token-selection',
    parentRevision: null,
    settingsRevision: 1,
    settings: { mode: 'research', preset: 'calm', translation: false, status: false, maxCalls: 4 },
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
        version: 1,
        id: `package-${index}`,
        revision: 1,
        title: `Package ${index}`,
        description: '',
        instructions: [],
        loreActivation: { mode: 'model' },
        nativeRisu: { version: 1, card: {}, assets: [], sourceHash: 'a'.repeat(64) },
        lore: [{ id: 'harbor', title: 'Harbor', description: '', text, loading: 'discoverable' }],
      })),
    },
  };
  const hooks: MainHooks = {
    signal: new AbortController().signal,
    approvedOrigins: [],
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
  validateLoreSelectionReceipt(result.snapshot.loreSelection);
  expect(send).toHaveBeenCalledTimes(1);
  expect(result.snapshot.loreSelection!.entries.map((entry) => entry.selected)).toEqual(
    Array.from({ length: attachments }, () => ['harbor'])
  );
  return { snapshot: result.snapshot, send };
}

const validate = (snapshot: RunSnapshot) =>
  validateLoreSelectionTokenBudgets(snapshot, loreSelectionTargets(snapshot));

describe('local-token selection receipt accounting', () => {
  it('recounts selected text with the real tokenizer without another request', async () => {
    const { snapshot, send } = await selectedSnapshot(2);
    const before = structuredClone(snapshot);
    expect(snapshot.loreSelection!.entries.map((entry) => entry.judgment!.selectedTokens)).toEqual([
      countTextTokens(text),
      countTextTokens(text),
    ]);
    expect(() => validate(snapshot)).not.toThrow();
    expect(snapshot).toEqual(before);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['count', 'budget', 'missing-judgment', 'failed-selection'] as const)(
    'rejects a modified %s while preserving source text',
    async (change) => {
      const { snapshot } = await selectedSnapshot();
      const entry = snapshot.loreSelection!.entries[0];
      if (change === 'count') entry.judgment!.selectedTokens = 0;
      if (change === 'budget') entry.budget++;
      if (change === 'missing-judgment') delete entry.judgment;
      if (change === 'failed-selection') entry.error = 'JEV_EXECUTION_FAILED';
      expect(() => validate(snapshot)).toThrow('LORE_SELECTION_TOKEN_BUDGET');
      expect(snapshot.profile!.packages![0].lore[0].text).toBe(text);
    }
  );

  it.each(['retention', 'selection', 'entries'] as const)(
    'enforces the shared %s budget across attachments, not just each receipt',
    async (limit) => {
      const { snapshot } = await selectedSnapshot(2);
      const policy = snapshot.profile!.loreContext as LoreContextPolicy;
      if (limit === 'retention') {
        policy.maxRetainedTokens = countTextTokens(text);
        for (const entry of snapshot.loreSelection!.entries)
          entry.budget = policy.maxRetainedTokens;
      }
      if (limit === 'selection') policy.judgment.maxSelectedTokens = countTextTokens(text);
      if (limit === 'entries') policy.maxRetainedEntries = 1;
      expect(() => validate(snapshot)).toThrow('LORE_SELECTION_TOKEN_BUDGET');
    }
  );
});
