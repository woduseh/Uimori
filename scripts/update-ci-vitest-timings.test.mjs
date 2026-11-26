import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertCompleteLinuxRun,
  formatLedger,
  measureArtifacts,
  mergeTimings,
} from './update-ci-vitest-timings.mjs';

const script = fileURLToPath(new URL('./update-ci-vitest-timings.mjs', import.meta.url));
const committedLedger = fileURLToPath(new URL('./ci-vitest-timings.json', import.meta.url));
const linuxRoot = '/home/runner/work/Uimori/Uimori';
const allFiles = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/fresh.test.ts', 'tests/new.test.ts'];

function artifacts(t, { platform = 'linux', root = linuxRoot } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'uimori-timings-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const write = (name, value) => {
    const file = path.join(directory, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  };
  const inventory = (shard) => ({
    commit: 'c'.repeat(40),
    shard,
    node: 'v24.0.0',
    platform,
    allFiles,
  });
  write('ci-vitest-1/vitest-1-inventory.json', inventory('1/2'));
  write('ci-vitest-1/vitest-1.json', {
    success: true,
    startTime: 900,
    testResults: [
      { name: `${root}/tests/a.test.ts`, status: 'passed', startTime: 1000, endTime: 3449 },
      { name: `${root}/tests/new.test.ts`, status: 'passed', startTime: 2000, endTime: 2030 },
    ],
  });
  write('vitest-2-inventory.json', inventory('2/2'));
  return directory;
}

test('Linux artifacts update and add measured files without inventing the rest', async (t) => {
  const measured = await measureArtifacts(artifacts(t));
  const ledger = { sourceRuns: ['1'], seconds: { 'tests/a.test.ts': 5, 'tests/b.test.ts': 1.2 } };
  assert.deepEqual(mergeTimings(ledger, measured, ['44800000001']), {
    sourceRuns: ['44800000001'],
    seconds: { 'tests/a.test.ts': 2.4, 'tests/b.test.ts': 1.2, 'tests/new.test.ts': 0.1 },
  });
  assert.deepEqual(mergeTimings(ledger, measured, []).sourceRuns, []);
});

test('Windows or other non-Linux artifacts are refused and the CLI writes nothing', async (t) => {
  await assert.rejects(measureArtifacts(artifacts(t, { platform: 'win32' })), /linux/i);
  await assert.rejects(measureArtifacts(artifacts(t, { root: 'D:/a/Uimori/Uimori' })), /Windows/);
  const directory = artifacts(t, { platform: 'win32', root: 'D:/a/Uimori/Uimori' });
  const output = path.join(directory, 'proposed.json');
  const before = readFileSync(committedLedger, 'utf8');
  const result = spawnSync(
    process.execPath,
    [script, directory, '--run', '1', '--output', output],
    {
      encoding: 'utf8',
      windowsHide: true,
    }
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(existsSync(output), false);
  assert.equal(readFileSync(committedLedger, 'utf8'), before);
});

test('keys for test files that are no longer collected are removed', async (t) => {
  const measured = await measureArtifacts(artifacts(t));
  const ledger = {
    sourceRuns: [],
    seconds: { 'tests/b.test.ts': 1.2, 'tests/story-performance.test.ts': 30 },
  };
  assert.deepEqual(Object.keys(mergeTimings(ledger, measured, []).seconds), [
    'tests/a.test.ts',
    'tests/b.test.ts',
    'tests/new.test.ts',
  ]);
});

test('formatted output keeps the committed ledger layout', () => {
  const text = readFileSync(committedLedger, 'utf8');
  assert.equal(formatLedger(JSON.parse(text)), text);
});

test('writing the committed ledger requires every Linux shard report', async (t) => {
  const measured = await measureArtifacts(artifacts(t));
  assert.equal(measured.shardTotal, 2);
  assert.equal(measured.reportCount, 1);
  assert.throws(() => assertCompleteLinuxRun(measured), /complete set of 2 Linux shard/);
  const directory = artifacts(t);
  const output = path.join(directory, 'proposed.json');
  const manyRuns = spawnSync(
    process.execPath,
    [script, directory, '--run', '1', '--run', '2', '--output', output],
    {
      encoding: 'utf8',
      windowsHide: true,
    }
  );
  assert.equal(manyRuns.status, 1);
  assert.match(manyRuns.stderr, /single --run/);
  assert.equal(existsSync(output), false);
});
