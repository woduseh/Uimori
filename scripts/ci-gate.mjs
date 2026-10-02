import { requiredJobs } from './ci-summary.mjs';
import { runExternal, requireSuccess } from './release-common.mjs';

function latestRun(runs, { commit, branch }) {
  const eligible = runs.filter(
    (run) =>
      run.head_sha === commit &&
      run.head_branch === branch &&
      ['push', 'workflow_dispatch'].includes(run.event) &&
      run.path === '.github/workflows/quality.yml'
  );
  eligible.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  const run = eligible[0];
  if (!run)
    throw new Error(
      `No eligible exact-commit Quality workflow found for ${branch}@${commit}. Run all required CI checks first.`
    );
  return run;
}

function runFailure(run, { commit, branch }) {
  return run.status === 'completed' && run.conclusion === 'success'
    ? null
    : `Exact-commit Quality workflow has not succeeded for ${branch}@${commit}. Run all required CI checks first.`;
}

function runDetails(run) {
  return `Selected Quality run for ${run.head_branch}@${run.head_sha}: ${run.html_url ?? 'URL unavailable'} (id=${run.id}, attempt=${run.run_attempt ?? 'unknown'}, status=${run.status ?? 'unknown'}, conclusion=${run.conclusion ?? 'none'})`;
}

function jobDetails(job) {
  return `status=${job.status ?? 'unknown'}, conclusion=${job.conclusion ?? 'none'}`;
}

function jobFailure(jobs) {
  const failures = [];
  for (const name of requiredJobs) {
    const matches = jobs.filter((job) => job.name === name);
    if (!matches.length) failures.push(`- ${name}: missing`);
    else if (matches.length > 1)
      failures.push(
        `- ${name}: duplicate (${matches.length} matches; ${matches.map(jobDetails).join('; ')})`
      );
    else if (matches[0].status !== 'completed' || matches[0].conclusion !== 'success')
      failures.push(`- ${name}: ${jobDetails(matches[0])}`);
  }
  return failures.length
    ? [
        'Required CI jobs are not uniquely successful:',
        ...failures,
        'A docs-only or partial run cannot authorize deployment.',
      ].join('\n')
    : null;
}

export function selectRun(runs, context) {
  const run = latestRun(runs, context);
  const failure = runFailure(run, context);
  if (failure) throw new Error(`${failure}\n${runDetails(run)}`);
  return run;
}

export function verifyJobs(jobs) {
  const failure = jobFailure(jobs);
  if (failure) throw new Error(failure);
  return requiredJobs;
}

/** Read GitHub's workflow and jobs for the pinned SHA; no locally fabricated receipt. */
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
  // Select once, without falling back to an older success. Read jobs even when this run failed
  // or is pending so the error explains every required-job problem in the current response.
  const run = latestRun(data.workflow_runs ?? [], { commit, branch });
  const workflowFailure = runFailure(run, { commit, branch });
  const jobs = [];
  try {
    // filter=latest includes successful jobs retained by GitHub's rerun-failed-jobs action.
    for (let page = 1; ; page++) {
      const result = JSON.parse(
        await gh([
          'api',
          `repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`,
        ])
      );
      if (
        !Array.isArray(result.jobs) ||
        !Number.isInteger(result.total_count) ||
        result.total_count < 0
      )
        throw new Error('Incomplete GitHub jobs response');
      jobs.push(...result.jobs);
      if (jobs.length >= result.total_count) break;
      if (!result.jobs.length) throw new Error('Missing GitHub jobs page');
    }
  } catch (error) {
    throw new Error(
      [runDetails(run), workflowFailure, `Required CI jobs could not be verified: ${error.message}`]
        .filter(Boolean)
        .join('\n'),
      { cause: error }
    );
  }
  const failures = [workflowFailure, jobFailure(jobs)].filter(Boolean);
  if (failures.length) throw new Error([runDetails(run), ...failures].join('\n'));
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
