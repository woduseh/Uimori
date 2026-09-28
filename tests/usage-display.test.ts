import { expect, test } from 'vitest';
import type { UsageTotals } from '../core/usage-report.js';
import {
  bucketLabel,
  usageBuckets,
  usageCost,
  usageUsd,
  validUsageRange,
} from '../web/usage-display.js';
const totals: UsageTotals = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  unknownInputCalls: 0,
  unknownOutputCalls: 0,
  reportedUsd: 0,
  estimatedUsd: 0,
  partialUsd: 0,
  partialCalls: 0,
  unknownCostCalls: 0,
  runningCalls: 0,
};
test('cost display separates zero, sub-cent values, and completely unknown bills', () => {
  expect(usageUsd(0)).toBe('US$0.00');
  expect(usageUsd(0.00001)).toBe('<US$0.01');
  expect(usageUsd(6.95307)).toBe('US$6.95');
  expect(usageCost({ ...totals, calls: 2, unknownCostCalls: 2 })).toBe('미확인');
  expect(
    usageCost({ ...totals, calls: 2, unknownCostCalls: 1, partialCalls: 1, partialUsd: 0.002 })
  ).toBe('<US$0.01');
});
test('daily chart preserves missing records, unknown bills, partial amounts, and inclusive bounds', () => {
  const { buckets, step } = usageBuckets({
    from: '2026-09-25',
    to: '2026-09-28',
    days: [
      {
        ...totals,
        day: '2026-09-26',
        calls: 2,
        reportedUsd: 0.2,
        partialUsd: 0.1,
        partialCalls: 1,
      },
      { ...totals, day: '2026-09-28', calls: 1, unknownCostCalls: 1 },
    ],
  });
  expect(step).toBe(1);
  expect(buckets).toHaveLength(4);
  expect(bucketLabel(buckets[0])).toContain('기록 없음');
  expect(buckets[1].amount).toBeCloseTo(0.3);
  expect(bucketLabel(buckets[1])).toContain('부분 추정 1회');
  expect(bucketLabel(buckets[3])).toContain('비용 미확인');
  expect(buckets[3].to).toBe('2026-09-28');
});
test('custom ranges reject partial/impossible/reversed dates and bound a multi-year chart without losing totals', () => {
  expect(validUsageRange({ from: '', to: '2026-09-28' })).toBe(false);
  expect(validUsageRange({ from: '2026-02-30', to: '2026-09-28' })).toBe(false);
  expect(validUsageRange({ from: '2026-09-29', to: '2026-09-28' })).toBe(false);
  const { buckets, step } = usageBuckets({
    from: '2020-01-01',
    to: '2026-09-28',
    days: [
      { ...totals, day: '2020-01-01', calls: 1, reportedUsd: 1 },
      { ...totals, day: '2026-09-28', calls: 2, estimatedUsd: 0.2, unknownCostCalls: 1 },
    ],
  });
  expect(step).toBeGreaterThan(1);
  expect(buckets.length).toBeLessThanOrEqual(60);
  expect(buckets.at(-1)?.to).toBe('2026-09-28');
  expect(buckets.reduce((sum, row) => sum + row.calls, 0)).toBe(3);
  expect(buckets.reduce((sum, row) => sum + row.amount, 0)).toBeCloseTo(1.2);
});
