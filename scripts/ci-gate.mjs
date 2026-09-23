import { requiredJobs } from './ci-summary.mjs';
import { runExternal, requireSuccess } from './release-common.mjs';

export function selectRun(runs, { commit, branch }) {
  const eligible = runs.filter(
    (run) =>
      run.head_sha === commit &&
      run.head_branch === branch &&
      ['push', 'workflow_dispatch'].includes(run.event) &&
      run.path === '.github/workflows/quality.yml'
  );
  eligible.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  const run = eligible[0];
  if (!run || run.status !== 'completed' || run.conclusion !== 'success')
    throw new Error(
      `Exact-commit Quality workflow has not succeeded for ${branch}@${commit}. Run all required CI checks first.`
    );
  return run;
}

export function verifyJobs(jobs) {
  for (const name of requiredJobs) {
    const matches = jobs.filter((job) => job.name === name);
    if (
      matches.length !== 1 ||
      matches[0].status !== 'completed' ||
      matches[0].conclusion !== 'success'
    )
      throw new Error(
        `Required CI job is not uniquely successful: ${name}. A docs-only or partial run cannot authorize deployment.`
      );
  }
  return requiredJobs;
}

/** Read GitHub's completed workflow and jobs for the pinned SHA; no locally fabricated receipt. */
export async function requireCi({ commit, branch, signal }, execute = runExternal) {
  const gh = async (args) =>
    requireSuccess(await execute('gh', args, { timeoutMs: 30_000, signal }), 'GitHub CI lookup')
      .output;
  const repository = (
    await gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  ).trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error('Invalid repository identity');
  const data = JSON.parse(
    await gh([
      'api',
      `repos/${repository}/actions/workflows/quality.yml/runs?head_sha=${commit}&branch=${encodeURIComponent(branch)}&per_page=100`,
    ])
  );
  const run = selectRun(data.workflow_runs ?? [], { commit, branch });
  const jobs = [];
  // filter=latest includes successful jobs retained by GitHub's rerun-failed-jobs action.
  for (let page = 1; ; page++) {
    const result = JSON.parse(
      await gh([
        'api',
        `repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`,
      ])
    );
    if (!Array.isArray(result.jobs) || !Number.isInteger(result.total_count))
      throw new Error('Incomplete GitHub jobs response');
    jobs.push(...result.jobs);
    if (jobs.length >= result.total_count) break;
    if (!result.jobs.length) throw new Error('Missing GitHub jobs page');
  }
  verifyJobs(jobs);
  return {
    status: 'PASS',
    repository,
    commit,
    branch,
    runId: run.id,
    attempt: run.run_attempt,
    url: run.html_url,
    jobs: requiredJobs,
  };
}
