import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireCi } from './ci-gate.mjs';
import { requiredJobs } from './ci-summary.mjs';

const commit = 'a'.repeat(40);
const context = { commit, branch: 'main' };
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
  html_url: 'https://github.com/owner/uimori/actions/runs/17',
};
const jobs = () =>
  requiredJobs.map((name) => ({ name, status: 'completed', conclusion: 'success' }));

function lookup({ runs = [run], pages = [jobs()], jobResponse } = {}) {
  const calls = [];
  return {
    calls,
    execute: async (program, args, options) => {
      calls.push({ program, args, options });
      assert.equal(program, 'gh');
      if (args[0] === 'repo') return { code: 0, output: 'owner/uimori' };
      assert.equal(args[0], 'api');
      assert.equal(args.length, 2); // Only read-only API calls, never a rerun or dispatch.
      if (args[1].includes('/workflows/'))
        return { code: 0, output: JSON.stringify({ workflow_runs: runs }) };
      if (jobResponse) return jobResponse(args);
      const page = Number(/page=(\d+)$/.exec(args[1])[1]);
      return {
        code: 0,
        output: JSON.stringify({
          total_count: pages.flat().length,
          jobs: pages[page - 1] ?? [],
        }),
      };
    },
  };
}

function assertRunDetails(error, selected = run) {
  assert.ok(error.message.includes(`${selected.head_branch}@${selected.head_sha}`));
  assert.ok(error.message.includes(selected.html_url));
  assert.ok(error.message.includes(`id=${selected.id}`));
  assert.ok(error.message.includes(`attempt=${selected.run_attempt}`));
  assert.ok(error.message.includes(`status=${selected.status}`));
  assert.ok(error.message.includes(`conclusion=${selected.conclusion ?? 'none'}`));
  return true;
}

test('deployment requires the exact commit, branch, workflow and a non-PR completed run', async () => {
  assert.equal((await requireCi(context, lookup().execute)).runId, 17);
  assert.equal(
    (await requireCi(context, lookup({ runs: [{ ...run, event: 'workflow_dispatch' }] }).execute))
      .runId,
    17
  );
  for (const change of [
    { head_sha: 'b'.repeat(40) },
    { head_branch: 'other' },
    { event: 'pull_request' },
    { event: 'pull_request_target' },
    { path: '.github/workflows/unrelated.yml' },
  ]) {
    const excluded = { ...run, id: 18, created_at: '2026-01-01T00:01:00Z', ...change };
    await assert.rejects(
      requireCi(context, lookup({ runs: [excluded] }).execute),
      /No eligible exact-commit/
    );
    assert.equal((await requireCi(context, lookup({ runs: [excluded, run] }).execute)).runId, 17);
  }
  for (const change of [
    { status: 'queued', conclusion: null },
    { status: 'in_progress', conclusion: null },
    { conclusion: 'failure' },
  ]) {
    const selected = { ...run, ...change };
    await assert.rejects(requireCi(context, lookup({ runs: [selected] }).execute), (error) =>
      assertRunDetails(error, selected)
    );
  }
});

test('a newer failed or pending run does not fall back to an old green one', async () => {
  for (const change of [
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
    { status: 'queued', conclusion: null },
    { status: 'in_progress', conclusion: null },
  ]) {
    const selected = {
      ...run,
      id: 18,
      html_url: 'https://github.com/owner/uimori/actions/runs/18',
      created_at: '2026-01-01T00:01:00Z',
      ...change,
    };
    for (const runs of [
      [run, selected],
      [selected, run],
    ])
      await assert.rejects(requireCi(context, lookup({ runs: runs }).execute), (error) =>
        assertRunDetails(error, selected)
      );
  }
  await assert.rejects(
    requireCi(context, lookup({ runs: [run, { ...run, id: 18, conclusion: 'failure' }] }).execute),
    /id=18/
  );
});

test('docs-only success and missing, skipped, duplicated shards cannot authorize deployment', async () => {
  assert.deepEqual((await requireCi(context, lookup().execute)).jobs, requiredJobs);
  for (const outcome of ['skipped', 'failure', 'cancelled', 'neutral', null]) {
    const values = jobs();
    values[1].conclusion = outcome;
    await assert.rejects(requireCi(context, lookup({ pages: [values] }).execute));
  }
  for (const status of ['queued', 'in_progress']) {
    const values = jobs();
    values[1].status = status;
    await assert.rejects(requireCi(context, lookup({ pages: [values] }).execute));
  }
  await assert.rejects(
    requireCi(context, lookup({ pages: [jobs().slice(1)] }).execute),
    /static: missing/
  );
  await assert.rejects(
    requireCi(context, lookup({ pages: [[...jobs(), jobs()[0]]] }).execute),
    /static: duplicate/
  );
});

test('job diagnostics report every failed, pending, missing and duplicated required job', async () => {
  const values = jobs();
  values[0].conclusion = 'failure';
  values[1].conclusion = 'skipped';
  values[2].status = 'in_progress';
  values[2].conclusion = null;
  values.pop();
  values.push({ ...values[3] });
  await assert.rejects(requireCi(context, lookup({ pages: [values] }).execute), (error) => {
    for (const detail of [
      'static: status=completed, conclusion=failure',
      'tooling: status=completed, conclusion=skipped',
      'linux-core: status=in_progress, conclusion=none',
      'selfhost: duplicate (2 matches',
      'tests (4/4): missing',
      'A docs-only or partial run cannot authorize deployment.',
    ])
      assert.ok(error.message.includes(detail), detail);
    assert.ok(!error.message.includes('- quality:'));
    return true;
  });
});

test('GitHub lookup reads all pages and retained rerun jobs without changing the success receipt', async () => {
  const values = jobs().map((job, index) => ({
    ...job,
    run_attempt: index < 3 ? 1 : 2,
  }));
  const { execute, calls } = lookup({ pages: [values.slice(0, 3), values.slice(3)] });
  const signal = new AbortController().signal;
  const result = await requireCi({ ...context, signal }, execute);
  assert.deepEqual(result, {
    status: 'PASS',
    repository: 'owner/uimori',
    commit,
    branch: 'main',
    runId: 17,
    attempt: 2,
    url: run.html_url,
    jobs: requiredJobs,
  });
  assert.deepEqual(
    calls.slice(2).map(({ args }) => args[1]),
    [1, 2].map(
      (page) => `repos/owner/uimori/actions/runs/17/jobs?filter=latest&per_page=100&page=${page}`
    )
  );
  assert.ok(
    calls.every(({ options }) => options.signal === signal && options.timeoutMs === 30_000)
  );
});

test('requireCi diagnoses only the selected latest failed run and all its required job problems', async () => {
  const selected = {
    ...run,
    id: 18,
    run_attempt: 3,
    html_url: 'https://github.com/owner/uimori/actions/runs/18',
    created_at: '2026-01-01T00:01:00Z',
    conclusion: 'failure',
  };
  const values = jobs();
  values[0].conclusion = 'failure';
  values[1].conclusion = 'cancelled';
  values.pop();
  const { execute, calls } = lookup({ runs: [run, selected], pages: [values] });
  await assert.rejects(requireCi(context, execute), (error) => {
    assertRunDetails(error, selected);
    assert.match(error.message, /Exact-commit Quality workflow has not succeeded/);
    assert.match(error.message, /static: status=completed, conclusion=failure/);
    assert.match(error.message, /tooling: status=completed, conclusion=cancelled/);
    assert.ok(error.message.includes('tests (4/4): missing'));
    return true;
  });
  assert.equal(calls.length, 3);
  assert.ok(calls[2].args[1].includes('/runs/18/jobs?filter=latest'));
});

test('requireCi reports queued and in-progress run context and jobs while staying blocked', async () => {
  for (const status of ['queued', 'in_progress']) {
    const selected = { ...run, status, conclusion: null };
    const { execute, calls } = lookup({ runs: [selected], pages: [[]] });
    await assert.rejects(requireCi(context, execute), (error) => {
      assertRunDetails(error, selected);
      for (const name of requiredJobs) assert.ok(error.message.includes(`- ${name}: missing`));
      return true;
    });
    assert.equal(calls.length, 3);
  }
});

test('requireCi does not inspect jobs for an ineligible SHA, branch, workflow or PR run', async () => {
  for (const change of [
    { head_sha: 'b'.repeat(40) },
    { head_branch: 'other' },
    { event: 'pull_request' },
    { path: '.github/workflows/unrelated.yml' },
  ]) {
    const { execute, calls } = lookup({ runs: [{ ...run, ...change }] });
    await assert.rejects(requireCi(context, execute), /No eligible exact-commit/);
    assert.equal(calls.length, 2);
  }
});

test('job lookup failures preserve selected run diagnostics and fail closed', async () => {
  for (const change of [{}, { conclusion: 'failure' }, { status: 'queued', conclusion: null }]) {
    const selected = { ...run, ...change };
    for (const response of [
      { code: 1, output: 'unavailable' },
      { code: 0, output: 'invalid JSON' },
      { code: 0, output: JSON.stringify({ total_count: 9 }) },
      { code: 0, output: JSON.stringify({ total_count: -1, jobs: [] }) },
      { code: 0, output: JSON.stringify({ total_count: 9, jobs: [] }) },
    ]) {
      const { execute, calls } = lookup({ runs: [selected], jobResponse: () => response });
      await assert.rejects(requireCi(context, execute), (error) => {
        assertRunDetails(error, selected);
        assert.match(error.message, /Required CI jobs could not be verified:/);
        assert.ok(error.cause instanceof Error);
        assert.ok(!error.message.includes('static: missing'));
        return true;
      });
      assert.equal(calls.length, 3);
    }
  }
});

test('a missing later job page keeps run context without treating unobserved jobs as missing', async () => {
  const { execute, calls } = lookup({
    jobResponse: (args) => ({
      code: 0,
      output: JSON.stringify({
        total_count: requiredJobs.length,
        jobs: args[1].endsWith('page=1') ? jobs().slice(0, 3) : [],
      }),
    }),
  });
  await assert.rejects(requireCi(context, execute), (error) => {
    assertRunDetails(error);
    assert.match(error.message, /Missing GitHub jobs page/);
    assert.ok(!error.message.includes('selfhost: missing'));
    return true;
  });
  assert.equal(calls.length, 4);
});

test('repository API errors fail closed instead of skipping CI', async () => {
  await assert.rejects(
    requireCi(context, async () => ({ code: 1, output: 'unavailable' })),
    /GitHub CI lookup/
  );
});
