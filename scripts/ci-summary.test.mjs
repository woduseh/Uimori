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
    selection: { scope: 'full' },
  }));
  const reports = allFiles.map(passingReport);
  return { inventories, reports };
}
function passingReport(file) {
  return {
    success: true,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    numPassedTests: 1,
    numPendingTests: 0,
    numTotalTests: 1,
    startTime: 100,
    testResults: [{ name: `C:\\runner\\repo\\${file.replaceAll('/', '\\')}`, endTime: 200 }],
  };
}
function pullRequestFixture(files, scope = 'impact') {
  const report = files.length && {
    ...passingReport(files[0]),
    numPassedTests: files.length,
    numTotalTests: files.length,
    testResults: files.flatMap((file) => passingReport(file).testResults),
  };
  return {
    inventories: [{ commit: sha, shard: '1/1', allFiles: files, files, selection: { scope } }],
    reports: [report || undefined],
  };
}
function jobFixture({ docs = false, full = false, pullRequest = false, windows = true } = {}) {
  const ran = (condition) => (!docs && condition ? 'success' : 'skipped');
  return Object.fromEntries(
    Object.entries({
      changes: 'success',
      static: 'success',
      tests: ran(!pullRequest),
      'tests-pr': ran(pullRequest),
      tooling: ran(!pullRequest || windows),
      'linux-browser-core': ran(true),
      'browser-full': full ? 'success' : 'skipped',
    }).map(([job, result]) => [job, { result }])
  );
}

test('matrix indices and cross-platform paths are explicit', () => {
  assert.deepEqual(parseShard('2/6'), { index: 2, total: 6 });
  for (const input of ['0/4', '5/4', '1/0', '1/101', '-1/4', '1', undefined])
    assert.throws(() => parseShard(input));
  assert.equal(testFile('C:\\repo\\tests\\one.test.ts'), 'tests/one.test.ts');
  assert.throws(() => testFile('../tests/../secret'));
});

test('aggregate job cannot pass a failed, cancelled, omitted or unexpectedly skipped dependency', () => {
  for (const event of ['push', 'workflow_dispatch', undefined]) {
    assert.equal(assertJobResults(jobFixture(), { event }).coverage, 'full-required');
    assert.equal(
      assertJobResults(jobFixture({ docs: true }), { docsOnly: true, event }).coverage,
      'docs-only'
    );
    assert.equal(
      assertJobResults(jobFixture({ full: true }), { fullBrowser: true, event }).status,
      'PASS'
    );
    const skippedTooling = jobFixture();
    skippedTooling.tooling.result = 'skipped';
    assert.throws(
      () => assertJobResults(skippedTooling, { event, windowsSensitive: false }),
      /tooling: expected success/
    );
    assert.throws(
      () => assertJobResults(jobFixture({ pullRequest: true }), { event }),
      /tests: expected success/
    );
  }
  for (const state of ['failure', 'cancelled', 'skipped', undefined]) {
    const jobs = jobFixture();
    jobs.tests.result = state;
    assert.throws(() => assertJobResults(jobs));
  }
  const unexpectedPr = jobFixture();
  unexpectedPr['tests-pr'].result = 'success';
  assert.throws(() => assertJobResults(unexpectedPr, { event: 'push' }), /tests-pr/);
  assert.throws(() => assertJobResults(jobFixture(), { fullBrowser: true }));
  const missing = jobFixture();
  delete missing['linux-browser-core'];
  assert.throws(() => assertJobResults(missing));
});

test('pull requests require the impact job and Windows tooling only for Windows-sensitive changes', () => {
  const event = 'pull_request';
  for (const windows of [true, false]) {
    const options = { event, windowsSensitive: windows };
    assert.equal(
      assertJobResults(jobFixture({ pullRequest: true, windows }), options).coverage,
      'impact'
    );
    assert.throws(
      () => assertJobResults(jobFixture({ pullRequest: true, windows: !windows }), options),
      /tooling/
    );
    assert.throws(() => assertJobResults(jobFixture(), options), /tests: expected skipped/);
    for (const job of ['tests-pr', 'linux-browser-core', 'static'])
      for (const state of ['failure', 'cancelled', 'skipped', undefined]) {
        const jobs = jobFixture({ pullRequest: true, windows });
        jobs[job].result = state;
        assert.throws(() => assertJobResults(jobs, options), new RegExp(job));
      }
  }
  assert.equal(
    assertJobResults(jobFixture({ docs: true, pullRequest: true }), { event, docsOnly: true })
      .coverage,
    'docs-only'
  );
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

test('main and manual runs accept only four complete full-scope shards', () => {
  for (const event of ['push', 'workflow_dispatch', undefined]) {
    assert.equal(summarizeVitest(...Object.values(vitestFixture()), sha, { event }).files, 4);
    for (const damage of [
      ({ inventories }) => {
        inventories[2].selection.scope = 'impact';
      },
      ({ inventories }) => {
        delete inventories[0].selection;
      },
      ({ reports }) => {
        reports[3] = undefined;
      },
      ({ inventories, reports }) => {
        inventories.splice(1);
        reports.splice(1);
      },
    ]) {
      const fixture = vitestFixture();
      damage(fixture);
      assert.throws(() => summarizeVitest(fixture.inventories, fixture.reports, sha, { event }));
    }
    const { inventories, reports } = pullRequestFixture([]);
    assert.throws(() => summarizeVitest(inventories, reports, sha, { event }));
  }
});

test('a pull request passes without a report only when the impact selection is empty', () => {
  const event = 'pull_request';
  const empty = pullRequestFixture([]);
  assert.deepEqual(summarizeVitest(empty.inventories, empty.reports, sha, { event }), {
    status: 'PASS',
    commit: sha,
    coverage: 'impact',
    files: 0,
    passed: 0,
    skipped: 0,
    shards: [],
  });
  const selected = ['tests/a.test.ts', 'tests/b.test.ts'];
  for (const scope of ['impact', 'full-required']) {
    const fixture = pullRequestFixture(selected, scope);
    const summary = summarizeVitest(fixture.inventories, fixture.reports, sha, { event });
    assert.equal(summary.coverage, scope);
    assert.equal(summary.files, 2);
    assert.equal(summary.passed, 2);
  }
  for (const damage of [
    ({ reports }) => {
      reports[0] = undefined;
    },
    ({ reports }) => {
      reports[0].testResults.pop();
    },
    ({ reports }) => {
      reports[0].success = false;
    },
    ({ inventories }) => {
      inventories[0].commit = 'b'.repeat(40);
    },
    ({ inventories }) => {
      inventories[0].shard = '1/4';
    },
  ]) {
    const fixture = pullRequestFixture(selected);
    damage(fixture);
    assert.throws(() => summarizeVitest(fixture.inventories, fixture.reports, sha, { event }));
  }
  for (const scope of ['full-required', 'full']) {
    const fixture = pullRequestFixture([], scope);
    assert.throws(() => summarizeVitest(fixture.inventories, fixture.reports, sha, { event }));
  }
  const inconsistent = pullRequestFixture(selected);
  inconsistent.inventories[0].files = [];
  inconsistent.reports[0] = undefined;
  assert.throws(() =>
    summarizeVitest(inconsistent.inventories, inconsistent.reports, sha, { event })
  );
  const fourShards = vitestFixture();
  assert.throws(() => summarizeVitest(fourShards.inventories, fourShards.reports, sha, { event }));
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
