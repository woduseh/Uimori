import { expect, test } from 'vitest';
import type { HelperTaskAttemptUsage } from '../core/helper.js';
import { helperTaskUsageTotals } from '../web/HelperTaskResults.js';

const attempt = (overrides: Partial<HelperTaskAttemptUsage>): HelperTaskAttemptUsage => ({
  id: 'execution',
  purpose: 'helper',
  status: 'completed',
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  reasoningTokens: null,
  costUsd: null,
  internalModelCalls: null,
  ...overrides,
});

test('helper usage preserves partial totals and unknown requests without counting subsets twice', () => {
  const totals = helperTaskUsageTotals([
    attempt({
      inputTokens: 300,
      outputTokens: 40,
      cachedInputTokens: 200,
      reasoningTokens: 10,
      costUsd: 0.02,
      internalModelCalls: 3,
    }),
    attempt({ inputTokens: 100, outputTokens: 0, costUsd: 0 }),
    attempt({}),
  ]);
  expect(totals.inputTokens).toEqual({ value: 400, reported: 2, unknown: 1 });
  expect(totals.outputTokens).toEqual({ value: 40, reported: 2, unknown: 1 });
  expect(totals.cachedInputTokens).toEqual({ value: 200, reported: 1, unknown: 2 });
  expect(totals.reasoningTokens).toEqual({ value: 10, reported: 1, unknown: 2 });
  expect(totals.costUsd).toEqual({ value: 0.02, reported: 2, unknown: 1 });
  expect(totals.internalModelCalls).toEqual({ value: 3, reported: 1, unknown: 2 });
});

test('missing provider usage is distinguishable from a reported zero and no requests', () => {
  expect(helperTaskUsageTotals([attempt({})]).costUsd).toEqual({
    value: 0,
    reported: 0,
    unknown: 1,
  });
  expect(helperTaskUsageTotals([attempt({ costUsd: 0 })]).costUsd).toEqual({
    value: 0,
    reported: 1,
    unknown: 0,
  });
  expect(helperTaskUsageTotals([]).costUsd).toEqual({ value: 0, reported: 0, unknown: 0 });
});
