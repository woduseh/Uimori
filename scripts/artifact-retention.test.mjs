import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { retainArtifacts } from './artifact-retention.mjs';
import { releaseFingerprint, identityKey } from './release-common.mjs';

async function fixture(t) {
  const repository = await realpath(await mkdtemp(path.join(tmpdir(), 'uimori-retention-')));
  t.after(() => rm(repository, { recursive: true, force: true }));
  async function record(
    name,
    status,
    number,
    { kind = 'playwright', owner = {}, summary = {} } = {}
  ) {
    const directory = path.join(repository, 'output', kind, name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'ownership.json'),
      JSON.stringify({
        directory,
        runId: name,
        ownerPid: 17,
        active: false,
        cleanup: { status: 'PASS' },
        ...owner,
      })
    );
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
  const run = (options) => retainArtifacts({ repository, isAlive: () => false, ...options });
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

test('active processes, incomplete cleanup, unowned files and current run are protected', async (t) => {
  const { repository, record, run } = await fixture(t);
  const protectedRuns = [
    await record('active', 'PASS', 0, { owner: { active: true } }),
    await record('alive-pid', 'PASS', 0, { owner: { ownerPid: 99 } }),
    await record('uncertain', 'FAIL', 0, { owner: { cleanup: { status: 'UNCERTAIN' } } }),
    await record('wrong-owner', 'PASS', 0, { owner: { directory: '/somewhere-else' } }),
    await record('unfinished', 'PASS', 0, { summary: { finishedAt: null } }),
    await record('current', 'PASS', 0),
  ];
  const unowned = path.join(repository, 'output', 'playwright', 'unowned');
  await mkdir(unowned);
  await record('newest', 'PASS', 20);
  const outcome = await run({
    apply: true,
    current: protectedRuns.at(-1),
    keepPassed: 1,
    isAlive: (pid) => pid === 99,
  });
  assert.deepEqual(outcome.removed, []);
  assert.ok([...protectedRuns, unowned].every(existsSync));
});

test('referenced evidence survives retention and unrelated output is never traversed', async (t) => {
  const { repository, record, run } = await fixture(t);
  const protectedRun = await record('proof', 'PASS', 0);
  await record('newest', 'PASS', 20);
  const data = path.join(repository, 'output', 'personal-data');
  await mkdir(data);
  await writeFile(path.join(data, 'user.db'), 'not a test artifact');
  const outcome = await run({
    apply: true,
    keepPassed: 1,
    protectedPaths: [path.join(protectedRun, 'summary.json')],
  });
  assert.equal(outcome.removed.length, 0);
  assert.ok(existsSync(data));
});

test('only a receipt for the current source protects linked browser evidence', async (t) => {
  const { repository, record, run } = await fixture(t);
  const proof = await record('proof', 'PASS', 0);
  await record('newest', 'PASS', 20);
  const identity = await releaseFingerprint(repository);
  const directory = path.join(repository, 'output/release/checks', identityKey(identity));
  await mkdir(directory, { recursive: true });
  const log = path.join(directory, 'selfhost.log');
  await writeFile(
    log,
    'human readable line\n' + JSON.stringify({ evidence: path.join(proof, 'summary.json') }) + '\n'
  );
  await writeFile(
    path.join(directory, 'summary.json'),
    JSON.stringify({ identity, checks: { 'verify:selfhost': { status: 'PASS', log } } })
  );
  assert.equal((await run({ keepPassed: 1, apply: true })).removed.length, 0);
  await mkdir(path.join(repository, 'core'));
  await writeFile(path.join(repository, 'core/change.ts'), 'export const changed = true;');
  assert.deepEqual((await run({ keepPassed: 1, apply: true })).removed, [proof]);
});

test('tooling retention uses the same ownership rule and malformed metadata cannot authorize deletion', async (t) => {
  const { record, run } = await fixture(t);
  const oldest = await record('old-tooling', 'PASS', 0, { kind: 'tooling' });
  await record('new-tooling', 'PASS', 1, { kind: 'tooling' });
  assert.deepEqual((await run({ keepPassed: 1, apply: true })).removed, [oldest]);
  const broken = await record('broken', 'PASS', 0);
  await writeFile(path.join(broken, 'ownership.json'), '{');
  const outcome = await run({ apply: true });
  assert.equal(outcome.status, 'WARN');
  assert.ok(existsSync(broken));
});

test('current release receipts also protect the tooling runner human-readable report link', async (t) => {
  const { repository, record, run } = await fixture(t);
  const proof = await record('tooling-proof', 'PASS', 0, { kind: 'tooling' });
  await record('tooling-newest', 'PASS', 20, { kind: 'tooling' });
  const identity = await releaseFingerprint(repository);
  const directory = path.join(repository, 'output/release/checks', identityKey(identity));
  await mkdir(directory, { recursive: true });
  const log = path.join(directory, 'quality-full.log');
  await writeFile(log, `Tooling tests PASS. Report: ${path.join(proof, 'summary.json')}\n`);
  await writeFile(
    path.join(directory, 'summary.json'),
    JSON.stringify({ identity, checks: { 'quality:full': { status: 'PASS', log } } })
  );
  assert.equal((await run({ keepPassed: 1, apply: true })).removed.length, 0);
  assert.ok(existsSync(proof));
});
