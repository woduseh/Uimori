import { describe, expect, it } from 'vitest';
import {
  appendLoreReads,
  DEFAULT_LORE_CONTEXT,
  DEFAULT_TOKEN_LORE_CONTEXT,
  loreBudget,
  measureLoreText,
  validateLoreContextPolicy,
  type RetainedLore,
} from '../core/lore-context.js';
import { countTextTokens } from '../core/text-tokens.js';

function read(id: string, text: string, lastUsed = 'scene1', start = 0): RetainedLore {
  return {
    id,
    text,
    start,
    end: start + text.length,
    revision: 1,
    hash: 'a'.repeat(64),
    title: id,
    lastUsed,
    origin: {
      sourceRevision: lastUsed,
      sourceHash: 'b'.repeat(64),
      runId: 'run1',
      callId: 'call1',
    },
  };
}

describe('explicit local-token lore policy', () => {
  it('preserves absent and explicit legacy policies rather than converting on read', () => {
    expect(validateLoreContextPolicy(undefined)).toEqual(DEFAULT_LORE_CONTEXT);
    const legacy = { ...DEFAULT_LORE_CONTEXT, maxRetainedChars: 8 };
    expect(validateLoreContextPolicy(legacy)).toEqual(legacy);
    expect(loreBudget(legacy)).toEqual({ unit: 'utf16', retained: 8, pinned: 200000 });
  });

  it('round-trips the new policy with an explicit estimator and no character fields', () => {
    const policy = validateLoreContextPolicy(
      JSON.parse(JSON.stringify(DEFAULT_TOKEN_LORE_CONTEXT))
    );
    expect(policy).toEqual(DEFAULT_TOKEN_LORE_CONTEXT);
    expect(loreBudget(policy)).toEqual({ unit: 'tokens', retained: 16000, pinned: 64000 });
    expect(Object.hasOwn(policy, 'maxRetainedChars')).toBe(false);
  });

  it('rejects mixed units, unrecognized estimators and missing token limits', () => {
    for (const policy of [
      { ...DEFAULT_TOKEN_LORE_CONTEXT, maxRetainedChars: 4 },
      { ...DEFAULT_LORE_CONTEXT, maxRetainedTokens: 4 },
      { ...DEFAULT_TOKEN_LORE_CONTEXT, tokenEstimator: 'future' },
    ])
      expect(() => validateLoreContextPolicy(policy)).toThrow('LORE_CONTEXT_POLICY_INVALID');
    const { maxPinnedTokens: _limit, ...missing } = DEFAULT_TOKEN_LORE_CONTEXT;
    expect(() => validateLoreContextPolicy(missing)).toThrow();
    const { tokenEstimator, ...limits } = DEFAULT_TOKEN_LORE_CONTEXT;
    const inherited = Object.assign(Object.create({ tokenEstimator }), limits);
    expect(() => validateLoreContextPolicy(inherited)).toThrow();
  });

  it('requires token policy fields to survive a JSON serialization round trip', () => {
    for (const key of [
      'maxRetainedTokens',
      'maxPinnedTokens',
      'maxRetainedEntries',
      'enabled',
      'judgment',
    ] as const) {
      const own: Record<string, unknown> = { ...DEFAULT_TOKEN_LORE_CONTEXT };
      delete own[key];
      const value = Object.assign(Object.create({ [key]: DEFAULT_TOKEN_LORE_CONTEXT[key] }), own);
      expect(() => validateLoreContextPolicy(value)).toThrow('LORE_CONTEXT_POLICY_INVALID');
    }
  });

  it.each([-1, 0.5, NaN, Infinity, 200001])('rejects invalid retained token limit %s', (limit) => {
    expect(() =>
      validateLoreContextPolicy({ ...DEFAULT_TOKEN_LORE_CONTEXT, maxRetainedTokens: limit })
    ).toThrow();
  });

  it('requires a valid token counter rather than silently substituting characters', () => {
    expect(() => measureLoreText('test', DEFAULT_TOKEN_LORE_CONTEXT)).toThrow(
      'LORE_TOKEN_COUNTER_REQUIRED'
    );
    for (const value of [-1, NaN, Infinity, 0.5])
      expect(() => measureLoreText('test', DEFAULT_TOKEN_LORE_CONTEXT, () => value)).toThrow(
        'LORE_TOKEN_COUNT_INVALID'
      );
    expect(
      measureLoreText('😀', DEFAULT_LORE_CONTEXT, () => {
        throw new Error('should not run');
      })
    ).toBe(2);
  });

  it('uses the local token budget rather than the character length at the boundary', () => {
    const entry = read('lore', ' 한국어 문맥과 일본어 日本語 and English.'.repeat(30));
    const tokens = countTextTokens(entry.text);
    const policy = { ...DEFAULT_TOKEN_LORE_CONTEXT, maxRetainedTokens: tokens };
    const admitted = appendLoreReads([], [entry], policy, ['scene1'], countTextTokens);
    expect(admitted.entries).toEqual([entry]);
    expect(admitted.retainedTokens).toBe(tokens);
    expect(admitted.retainedChars).toBe(entry.text.length);
    const overflow = appendLoreReads(
      [],
      [entry],
      { ...policy, maxRetainedTokens: tokens - 1 },
      ['scene1'],
      countTextTokens
    );
    expect(overflow.entries).toEqual([]);
  });

  it('counts uncovered slices while retaining the exact original UTF-16 coordinates', () => {
    const full = read('lore', '😀abcdef');
    const first = { ...full, text: full.text.slice(0, 4), end: 4 };
    const input = structuredClone(first);
    const merged = appendLoreReads(
      [first],
      [full],
      DEFAULT_TOKEN_LORE_CONTEXT,
      ['scene1'],
      countTextTokens
    );
    expect(merged.entries.map(({ start, end, text }) => ({ start, end, text }))).toEqual([
      { start: 0, end: 4, text: '😀ab' },
      { start: 4, end: 8, text: 'cdef' },
    ]);
    expect(merged.retainedTokens).toBe(countTextTokens('😀ab') + countTextTokens('cdef'));
    expect(first).toEqual(input);
  });

  it('evicts whole entries without changing sources and keeps count limits independent', () => {
    const old = read('old', 'older reference'),
      recent = read('new', 'new reference', 'scene2');
    const original = structuredClone([old, recent]);
    const result = appendLoreReads(
      [old],
      [recent],
      { ...DEFAULT_TOKEN_LORE_CONTEXT, maxRetainedEntries: 1 },
      ['scene1', 'scene2'],
      countTextTokens
    );
    expect(result.entries).toEqual([recent]);
    expect(result.droppedEntries).toBe(1);
    expect([old, recent]).toEqual(original);
    const empty = appendLoreReads(
      [],
      [recent],
      { ...DEFAULT_TOKEN_LORE_CONTEXT, maxRetainedTokens: 0 },
      ['scene2'],
      countTextTokens
    );
    expect(empty.entries).toEqual([]);
    expect(empty.retainedTokens).toBe(0);
  });

  it('keeps legacy statistics unchanged and omits the new field', () => {
    const result = appendLoreReads(
      [],
      [read('lore', 'abcd')],
      { ...DEFAULT_LORE_CONTEXT, maxRetainedChars: 3 },
      ['scene1']
    );
    expect(result).toEqual({ entries: [], appendedChars: 4, droppedEntries: 1, retainedChars: 0 });
  });
});
