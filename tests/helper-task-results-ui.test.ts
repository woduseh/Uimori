import { expect, test } from 'vitest';
import type { HelperTaskAttemptUsage } from '../core/helper.js';
import { helperTaskUsageTotals } from '../web/HelperTaskResults.js';
import { helperChangeLocationParts } from '../web/helper-change-location.js';

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

test('package settings a helper change names read as the editor sections that hold them', () => {
  const name = (path: string[]) =>
    helperChangeLocationParts({ kind: 'resource-field', path }).map((part) => part.text);
  expect(name(['package', 'portraitImageId'])).toEqual(['기본 정보']);
  expect(name(['package', 'loreActivation', 'mode'])).toEqual(['로어북']);
  expect(name(['package', 'modules'])).toEqual(['고급 설정', '함께 쓰는 모듈']);
  expect(name(['package', 'imageHandoff', 'enabled'])).toEqual(['고급 설정', '배경 HTML과 CSS']);
  expect(name(['package', 'nativeRisu', 'card', 'creator_notes'])).toEqual([
    '기본 정보',
    '제작 정보',
  ]);
});
