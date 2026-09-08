import assert from 'node:assert/strict';
import { test } from 'node:test';
import { doctorFailureState } from '../scripts/doctor-result.mjs';

function blockedBrowser() {
  return {
    status: 'BLOCKED',
    cleanup: { status: 'PASS' },
    checks: [
      'supported-node-runtime',
      'node-child-ready-exit',
      'writable-directory',
      'file-sqlite-transaction-reopen',
      'localhost-bind-http',
    ]
      .map((name) => ({ name, status: 'PASS', required: true }))
      .concat({ name: 'browser-launch-and-local-page', status: 'BLOCKED', required: true }),
  };
}

test('milestone callers can continue API checks only when the browser alone is blocked', () => {
  assert.deepEqual(doctorFailureState(blockedBrowser()), { status: 'BLOCKED', browserOnly: true });
});

for (const name of [
  'supported-node-runtime',
  'node-child-ready-exit',
  'writable-directory',
  'file-sqlite-transaction-reopen',
  'localhost-bind-http',
]) {
  test(`milestone callers stop when ${name} is blocked, failed or missing`, () => {
    for (const status of ['BLOCKED', 'FAIL', 'missing']) {
      const result = blockedBrowser();
      if (status === 'missing')
        result.checks = result.checks.filter((check) => check.name !== name);
      else result.checks.find((check) => check.name === name).status = status;
      const classified = doctorFailureState(result);
      assert.equal(classified.browserOnly, false);
      if (status === 'FAIL') assert.equal(classified.status, 'FAIL');
    }
  });
}

test('doctor failure and cleanup failure remain FAIL in both milestone callers', () => {
  const result = blockedBrowser();
  result.status = 'FAIL';
  assert.deepEqual(doctorFailureState(result), { status: 'FAIL', browserOnly: false });
  result.status = 'BLOCKED';
  result.cleanup.status = 'FAIL';
  assert.deepEqual(doctorFailureState(result), { status: 'FAIL', browserOnly: false });
});

test('an unexecuted browser probe does not count as a confirmed browser-only blocker', () => {
  const result = blockedBrowser();
  result.checks.at(-1).status = 'NOT_RUN';
  assert.equal(doctorFailureState(result).browserOnly, false);
});
