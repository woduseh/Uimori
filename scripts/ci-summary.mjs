import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const vitestShards = 4;
export const browserShards = 3;
export const requiredJobs = [
  'static',
  'tooling',
  'linux-browser-core',
  'quality',
  ...Array.from({ length: vitestShards }, (_, i) => `tests (${i + 1}/${vitestShards})`),
];

export function parseShard(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
  if (!match || +match[1] < 1 || +match[1] > +match[2] || +match[2] > 100)
    throw new Error('Use a shard index/count such as 1/4');
  return { index: +match[1], total: +match[2] };
}

export function testFile(value) {
  const normalized = String(value).replaceAll('\\', '/');
  const index = normalized.lastIndexOf('/tests/');
  const result = index < 0 ? normalized : normalized.slice(index + 1);
  if (!result.startsWith('tests/') || result.split('/').includes('..'))
    throw new Error(`Invalid test file: ${value}`);
  return result;
}

export function assertJobResults(
  needs,
  {
    docsOnly = false,
    fullBrowser = false,
    changedBrowser = false,
    event,
    windowsSensitive = true,
  } = {}
) {
  const pullRequest = event === 'pull_request';
  const ran = (condition) => (!docsOnly && condition ? 'success' : 'skipped');
  const expected = {
    changes: 'success',
    static: 'success',
    tests: ran(!pullRequest),
    'tests-pr': ran(pullRequest),
    tooling: ran(!pullRequest || windowsSensitive),
    'linux-browser-core': ran(true),
    'browser-full': fullBrowser ? 'success' : 'skipped',
    'browser-changed': changedBrowser ? 'success' : 'skipped',
  };
  for (const [job, result] of Object.entries(expected))
    if (needs[job]?.result !== result)
      throw new Error(`${job}: expected ${result}, received ${needs[job]?.result ?? 'missing'}`);
  return {
    status: 'PASS',
    coverage: docsOnly ? 'docs-only' : pullRequest ? 'impact' : 'full-required',
    fullBrowser,
    changedBrowser,
  };
}

export function assertPartition(expected, parts) {
  if (!expected.length || new Set(expected).size !== expected.length)
    throw new Error('Empty or duplicate full test inventory');
  const seen = new Set();
  const wanted = new Set(expected);
  for (const part of parts) {
    if (!part.length) throw new Error('Empty shard inventory');
    for (const file of part) {
      if (!wanted.has(file)) throw new Error(`Unexpected test: ${file}`);
      if (seen.has(file)) throw new Error(`Duplicate test across shards: ${file}`);
      seen.add(file);
    }
  }
  const missing = expected.filter((file) => !seen.has(file));
  if (missing.length) throw new Error(`Missing tests: ${missing.join(', ')}`);
  return seen.size;
}

export function browserCases(report) {
  const cases = [];
  function visit(suite, parents = []) {
    const titles = [...parents, suite.title ?? ''];
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? []) {
        cases.push(
          JSON.stringify([
            String(spec.file ?? suite.file ?? '').replaceAll('\\', '/'),
            spec.line ?? 0,
            spec.column ?? 0,
            ...titles,
            spec.title,
            test.projectName ?? '',
          ])
        );
      }
    for (const child of suite.suites ?? []) visit(child, titles);
  }
  for (const suite of report.suites ?? []) visit(suite);
  return cases;
}

export function summarizeBrowser(reports, expectedSha) {
  if (reports.length !== browserShards) throw new Error('Missing browser shard report');
  const expected = reports[0].selection.allTests;
  const parts = reports.map((report, i) => {
    if (
      report.status !== 'PASS' ||
      report.commit !== expectedSha ||
      report.selection.shard !== `${i + 1}/${browserShards}` ||
      JSON.stringify(report.selection.allTests) !== JSON.stringify(expected)
    )
      throw new Error('Browser shard failed or collection/identity differs');
    return report.testCases;
  });
  return {
    status: 'PASS',
    commit: expectedSha,
    tests: assertPartition(expected, parts),
    shards: reports.map((report, i) => ({
      shard: report.selection.shard,
      tests: parts[i].length,
      elapsedMs: Date.parse(report.finishedAt) - Date.parse(report.startedAt),
    })),
  };
}

export function vitestShardCount(event) {
  return event === 'pull_request' ? 1 : vitestShards;
}

function passedFiles(report, label) {
  if (
    report.success !== true ||
    report.numFailedTests ||
    report.numFailedTestSuites ||
    !report.testResults?.length
  )
    throw new Error(`${label} did not pass`);
  if (
    !['numPassedTests', 'numPendingTests', 'numTotalTests'].every(
      (key) => Number.isInteger(report[key]) && report[key] >= 0
    ) ||
    !report.numTotalTests
  )
    throw new Error(`${label} has no complete test counts`);
  return report.testResults.map((result) => testFile(result.name));
}

export function summarizeDistVitest(inventory, report, expectedSha) {
  if (
    !inventory ||
    inventory.shard !== '1/1' ||
    inventory.commit !== expectedSha ||
    inventory.selection?.dist !== 'only' ||
    inventory.selection?.scope !== 'full' ||
    !inventory.allFiles?.length
  )
    throw new Error('Compiled-server Vitest evidence is missing, stale or not a full run');
  if (!report) throw new Error('Missing compiled-server Vitest report');
  const files = assertPartition(inventory.allFiles, [
    passedFiles(report, 'Compiled-server Vitest run'),
  ]);
  return { files, passed: report.numPassedTests, skipped: report.numPendingTests };
}

export function summarizeVitest(inventories, reports, expectedSha, { event } = {}) {
  const pullRequest = event === 'pull_request';
  const total = vitestShardCount(event);
  if (inventories.length !== total) throw new Error('Missing Vitest shard inventory');
  const expected = inventories[0].allFiles;
  for (const [i, inventory] of inventories.entries())
    if (
      inventory.shard !== `${i + 1}/${total}` ||
      inventory.commit !== expectedSha ||
      JSON.stringify(inventory.allFiles) !== JSON.stringify(expected) ||
      (!pullRequest && inventory.selection?.scope !== 'full')
    )
      throw new Error('Shard identity or full collection differs');
  const coverage = pullRequest ? inventories[0].selection?.scope : 'full';
  if (coverage === 'impact' && !inventories[0].files?.length && !expected.length)
    return {
      status: 'PASS',
      commit: expectedSha,
      coverage,
      files: 0,
      passed: 0,
      skipped: 0,
      shards: [],
    };
  if (reports.length !== total || reports.some((report) => !report))
    throw new Error('Missing Vitest shard report');
  const parts = reports.map((report, i) => passedFiles(report, `Vitest shard ${i + 1}`));
  const files = assertPartition(expected, parts);
  return {
    status: 'PASS',
    commit: expectedSha,
    coverage,
    files,
    passed: reports.reduce((sum, report) => sum + report.numPassedTests, 0),
    skipped: reports.reduce((sum, report) => sum + report.numPendingTests, 0),
    shards: reports.map((report, i) => ({
      shard: inventories[i].shard,
      files: parts[i].length,
      elapsedMs: Math.max(...report.testResults.map((test) => test.endTime)) - report.startTime,
    })),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2];
    if (mode === 'jobs') {
      console.log(
        JSON.stringify(
          assertJobResults(JSON.parse(process.env.UIMORI_CI_NEEDS ?? '{}'), {
            docsOnly: process.env.UIMORI_DOCS_ONLY === 'true',
            fullBrowser: process.env.UIMORI_FULL_BROWSER === 'true',
            changedBrowser: Boolean(process.env.UIMORI_BROWSER_DOMAINS),
            event: process.env.GITHUB_EVENT_NAME,
            windowsSensitive: process.env.UIMORI_WINDOWS_SENSITIVE !== 'false',
          })
        )
      );
    } else if (mode === 'vitest') {
      const directory = process.argv[3] ?? 'output/ci';
      const event = process.env.GITHUB_EVENT_NAME;
      const load = async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'));
      const loadIfPresent = (name) =>
        load(name).catch((error) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
      const inventories = [],
        reports = [];
      for (let i = 1; i <= vitestShardCount(event); i++) {
        inventories.push(await load(`vitest-${i}-inventory.json`));
        reports.push(await loadIfPresent(`vitest-${i}.json`));
      }
      const commit = process.env.GITHUB_SHA ?? inventories[0].commit;
      const summary = {
        ...summarizeVitest(inventories, reports, commit, { event }),
        dist: summarizeDistVitest(
          await loadIfPresent('vitest-dist-1-inventory.json'),
          await loadIfPresent('vitest-dist-1.json'),
          commit
        ),
      };
      await writeFile(
        path.join(directory, 'summary.json'),
        JSON.stringify(summary, null, 2) + '\n'
      );
      console.log(JSON.stringify(summary, null, 2));
    } else if (mode === 'browser') {
      const directory = process.argv[3] ?? 'output/ci';
      const reports = [];
      for (let i = 1; i <= browserShards; i++)
        reports.push(JSON.parse(await readFile(path.join(directory, `browser-${i}.json`), 'utf8')));
      console.log(
        JSON.stringify(
          summarizeBrowser(reports, process.env.GITHUB_SHA ?? reports[0].commit),
          null,
          2
        )
      );
    } else throw new Error('Use ci-summary.mjs jobs | vitest | browser [report-directory]');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
