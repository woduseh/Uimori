import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { retainArtifacts } from './artifact-retention.mjs';

async function fixture(t) {
  const repository = await realpath(await mkdtemp(path.join(tmpdir(), 'uimori-retention-')));
  t.after(() => rm(repository, { recursive: true, force: true }));
  async function record(name, status, number, { kind = 'playwright', summary = {} } = {}) {
    const directory = path.join(repository, 'output', kind, name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'summary.json'),
      JSON.stringify({
        status,
        finishedAt: new Date(Date.UTC(2026, 0, 1, 0, number)).toISOString(),
        ...summary,
      })
    );
    return directory;
  }
  const run = (options) => retainArtifacts({ repository, ...options });
  return { repository, record, run };
}

test('preview retains recent successes/failures and deletes nothing', async (t) => {
  const { record, run } = await fixture(t);
  const passed = [],
    failed = [];
  for (let i = 0; i < 5; i++) passed.push(await record(`pass-${i}`, 'PASS', i));
  for (let i = 0; i < 7; i++) failed.push(await record(`fail-${i}`, 'FAIL', i));
  const plan = await run({});
  assert.equal(plan.status, 'PLAN');
  assert.deepEqual(
    new Set(plan.candidates),
    new Set([...passed.slice(0, 2), ...failed.slice(0, 2)])
  );
  assert.ok([...passed, ...failed].every(existsSync));
  const applied = await run({ apply: true });
  assert.equal(applied.status, 'PASS');
  assert.equal(applied.removed.length, 4);
  assert.equal((await run({ apply: true })).removed.length, 0);
});

test('unfinished runs, folders without a summary and the current run are kept', async (t) => {
  const { repository, record, run } = await fixture(t);
  const kept = [
    await record('unfinished', 'FAIL', 0, { summary: { finishedAt: null } }),
    await record('current', 'PASS', 0),
  ];
  const bare = path.join(repository, 'output', 'playwright', 'bare');
  await mkdir(bare);
  const malformed = await record('malformed', 'PASS', 0);
  await writeFile(path.join(malformed, 'summary.json'), '{');
  await record('newest', 'PASS', 20);
  const outcome = await run({ apply: true, current: kept.at(-1), keepPassed: 1 });
  assert.deepEqual(outcome.removed, []);
  assert.ok([...kept, bare, malformed].every(existsSync));
});

test('tooling output follows the same rule and unrelated output is never traversed', async (t) => {
  const { repository, record, run } = await fixture(t);
  const oldest = await record('old-tooling', 'PASS', 0, { kind: 'tooling' });
  await record('new-tooling', 'PASS', 1, { kind: 'tooling' });
  const data = path.join(repository, 'output', 'personal-data');
  await mkdir(data);
  await writeFile(path.join(data, 'user.db'), 'not a test artifact');
  assert.deepEqual((await run({ keepPassed: 1, apply: true })).removed, [oldest]);
  assert.ok(existsSync(data));
});
