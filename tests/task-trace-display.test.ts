import { expect, test } from 'vitest';
import { formatDurationMs, traceCostSummary } from '../web/task-trace.js';

test('task record duration uses the next unit when rounding crosses its boundary', () => {
  expect(formatDurationMs(999.5)).toBe('1초');
  expect(formatDurationMs(59_500)).toBe('1분 0초');
});

test('a tiny known cost subtotal has an unambiguous lower bound', () => {
  expect(
    traceCostSummary({ usd: null, subtotalUsd: 0.00031, attemptCount: 2, unknownCount: 1 })
  ).toBe('$0.00031+');
});
