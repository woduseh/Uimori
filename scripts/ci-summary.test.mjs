import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseShard,
  testFile,
  assertJobResults,
  assertPartition,
  summarizeVitest,
  summarizeBrowser,
  browserCases,
} from './ci-summary.mjs';

const sha = 'a'.repeat(40);
function vitestFixture() {
  const allFiles = ['a', 'b', 'c', 'd'].map((name) => `tests/${name}.test.ts`);
  const inventories = allFiles.map((file, i) => ({
    commit: sha,
    shard: `${i + 1}/4`,
    allFiles,
    files: [file],
  }));
  const reports = allFiles.map((file) => ({
    success: true,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    numPassedTests: 1,
    numPendingTests: 0,
    numTotalTests: 1,
    startTime: 100,
    testResults: [{ name: `C:\\runner\\repo\\${file.replaceAll('/', '\\')}`, endTime: 200 }],
  }));
  return { inventories, reports };
}
function jobFixture(docs = false, full = false) {
  return Object.fromEntries(
    ['changes', 'static', 'tests', 'tooling', 'linux-core', 'selfhost', 'browser-full'].map(
      (job) => [
        job,
        {
          result:
            job === 'browser-full'
              ? full
                ? 'success'
                : 'skipped'
              : docs && !['changes', 'static'].includes(job)
                ? 'skipped'
                : 'success',
        },
      ]
    )
  );
}

test('matrix indices and cross-platform paths are explicit', () => {
  assert.deepEqual(parseShard('2/4'), { index: 2, total: 4 });
  for (const input of ['0/4', '5/4', '1/0', '1/101', '-1/4', '1', undefined])
    assert.throws(() => parseShard(input));
  assert.equal(testFile('C:\\repo\\tests\\one.test.ts'), 'tests/one.test.ts');
  assert.throws(() => testFile('../tests/../secret'));
});

test('aggregate job cannot pass a failed, cancelled, omitted or unexpectedly skipped dependency', () => {
  assert.equal(assertJobResults(jobFixture()).coverage, 'full-required');
  assert.equal(assertJobResults(jobFixture(true), { docsOnly: true }).coverage, 'docs-only');
  assert.equal(assertJobResults(jobFixture(false, true), { fullBrowser: true }).status, 'PASS');
  for (const state of ['failure', 'cancelled', 'skipped', undefined]) {
    const jobs = jobFixture();
    jobs.tests.result = state;
    assert.throws(() => assertJobResults(jobs));
  }
  assert.throws(() => assertJobResults(jobFixture(), { fullBrowser: true }));
  const missing = jobFixture();
  delete missing.selfhost;
  assert.throws(() => assertJobResults(missing));
});

test('partition requires exact union, not just matching counts', () => {
  assert.equal(assertPartition(['a', 'b'], [['b'], ['a']]), 2);
  for (const parts of [[['a'], ['a']], [['a']], [['a'], ['x']], [[], ['a', 'b']]])
    assert.throws(() => assertPartition(['a', 'b'], parts));
});

test('Vitest reports retain skips, timing and full file coverage', () => {
  const { inventories, reports } = vitestFixture();
  reports[0].numPassedTests = 0;
  reports[0].numPendingTests = 1;
  const summary = summarizeVitest(inventories, reports, sha);
  assert.equal(summary.files, 4);
  assert.equal(summary.passed, 3);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.shards[0].elapsedMs, 100);
});

test('stale or incomplete shard evidence is not accepted', () => {
  for (const damage of [
    ({ inventories }) => {
      inventories[0].commit = 'b'.repeat(40);
    },
    ({ inventories }) => {
      inventories[1].shard = '1/4';
    },
    ({ reports }) => {
      reports[0].success = false;
    },
    ({ reports }) => {
      reports.pop();
    },
    ({ reports }) => {
      reports[0].testResults = [];
    },
    ({ reports }) => {
      reports[0].testResults[0].name = reports[1].testResults[0].name;
    },
  ]) {
    const fixture = vitestFixture();
    damage(fixture);
    assert.throws(() => summarizeVitest(fixture.inventories, fixture.reports, sha));
  }
});

test('browser inventory spans nested suites/projects and aggregate detects a lost scenario', () => {
  const report = {
    suites: [
      {
        title: 'a.spec.ts',
        suites: [
          {
            title: 'group',
            specs: [
              {
                title: 'case',
                file: 'a.spec.ts',
                line: 7,
                tests: [{ projectName: 'one' }, { projectName: 'two' }],
              },
            ],
          },
        ],
      },
    ],
  };
  const cases = browserCases(report);
  assert.equal(cases.length, 2);
  assert.notEqual(cases[0], cases[1]);
  const allTests = ['case-1', 'case-2', 'case-3'];
  const reports = allTests.map((key, i) => ({
    commit: sha,
    status: 'PASS',
    selection: { allTests, shard: `${i + 1}/3` },
    testCases: [key],
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:00:01Z',
  }));
  assert.equal(summarizeBrowser(reports, sha).tests, 3);
  reports[1].testCases = [allTests[0]];
  assert.throws(() => summarizeBrowser(reports, sha));
});
