import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireCi, selectRun, verifyJobs } from './ci-gate.mjs';
import { requiredJobs } from './ci-summary.mjs';
const commit = 'a'.repeat(40);
const run = {
  id: 17,
  head_sha: commit,
  head_branch: 'main',
  path: '.github/workflows/quality.yml',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-01-01T00:00:00Z',
  run_attempt: 2,
};
const jobs = () =>
  requiredJobs.map((name) => ({ name, status: 'completed', conclusion: 'success' }));

test('deployment requires the exact commit, branch, workflow and a non-PR completed run', () => {
  assert.equal(selectRun([run], { commit, branch: 'main' }).id, 17);
  for (const change of [
    { head_sha: 'b'.repeat(40) },
    { head_branch: 'other' },
    { event: 'pull_request' },
    { path: '.github/workflows/unrelated.yml' },
    { status: 'in_progress' },
    { conclusion: 'failure' },
  ])
    assert.throws(() => selectRun([{ ...run, ...change }], { commit, branch: 'main' }));
});

test('a newer failed or pending run does not fall back to an old green one', () => {
  for (const conclusion of ['failure', 'cancelled', null])
    assert.throws(() =>
      selectRun([run, { ...run, id: 18, created_at: '2026-01-01T00:01:00Z', conclusion }], {
        commit,
        branch: 'main',
      })
    );
});

test('docs-only success and missing, skipped, duplicated shards cannot authorize deployment', () => {
  verifyJobs(jobs());
  for (const outcome of ['skipped', 'failure', 'cancelled']) {
    const values = jobs();
    values[1].conclusion = outcome;
    assert.throws(() => verifyJobs(values));
  }
  assert.throws(() => verifyJobs(jobs().slice(1)));
  assert.throws(() => verifyJobs([...jobs(), jobs()[0]]));
});

test('GitHub lookup reads all job pages, including successful jobs retained across failed-job reruns', async () => {
  const seen = [];
  const execute = async (_program, args) => {
    seen.push(args);
    if (args[0] === 'repo') return { code: 0, output: 'owner/uimori' };
    if (args[1].includes('/workflows/'))
      return { code: 0, output: JSON.stringify({ workflow_runs: [run] }) };
    const page = args[1].endsWith('page=1') ? jobs().slice(0, 3) : jobs().slice(3);
    return { code: 0, output: JSON.stringify({ total_count: requiredJobs.length, jobs: page }) };
  };
  const result = await requireCi({ commit, branch: 'main' }, execute);
  assert.equal(result.status, 'PASS');
  assert.equal(result.commit, commit);
  assert.equal(result.attempt, 2);
  assert.ok(seen.some((args) => args[1]?.includes('filter=latest')));
  assert.ok(seen.some((args) => args[1]?.includes('page=2')));
});

test('API errors fail closed instead of skipping CI', async () => {
  await assert.rejects(
    requireCi({ commit, branch: 'main' }, async () => ({ code: 1, output: 'unavailable' })),
    /GitHub CI lookup/
  );
});
