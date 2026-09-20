import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jevProbePassed } from './jev-probe-result.mjs';

test('only the expected budget rejection with zero transport passes the budget probe', () => {
  const entry = {
    expected: 'budget-rejected',
    errorCode: 'JEV_INPUT_BUDGET',
    attemptCount: 0,
    transportCount: 0,
  };
  assert.equal(jevProbePassed(entry), true);
  for (const change of [{ errorCode: 'NETWORK_ERROR' }, { attemptCount: 1 }, { transportCount: 1 }])
    assert.equal(jevProbePassed({ ...entry, ...change }), false);
});
test('live acceptance requires one completed transport carrying the whole state', () => {
  const entry = {
    expected: 'completed',
    status: 'completed',
    attemptCount: 1,
    transportCount: 1,
    wholeStateMatches: true,
  };
  assert.equal(jevProbePassed(entry), true);
  for (const change of [
    { status: 'error' },
    { attemptCount: 0 },
    { transportCount: 0 },
    { wholeStateMatches: false },
  ])
    assert.equal(jevProbePassed({ ...entry, ...change }), false);
});
