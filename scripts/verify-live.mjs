import path from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { root, newId, json, assertBuild } from './lib.mjs';

// Default execution is a metadata-only preflight. The previous paid scenarios are retired pending a current-contract evaluation plan.
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'node scripts/verify-live.mjs [--preflight | --execute]\nRequired environment: NR_VERTEX_PROJECT, GOOGLE_APPLICATION_CREDENTIALS (file reference), NR_VERTEX_REQUEST_TIER=flex.\nDefault/--preflight performs no authentication or network request. --execute is BLOCKED before authentication, server launch or database creation: the previous prompt/chunk evaluation contract is retired. Per-run call, timeout and output limits remain in force.'
  );
  process.exit(0);
}
if (
  args.some((arg) => !['--preflight', '--execute'].includes(arg)) ||
  new Set(args).size !== args.length ||
  args.length > 1
) {
  console.error('INVALID_LIVE_VERIFY_OPTIONS');
  process.exit(2);
}
const execute = args[0] === '--execute';
const runId = `live-${newId()}`;
const directory = path.join(root, 'output', 'live', runId);
await mkdir(directory, { recursive: true });
const safeCode = (error, fallback = 'LIVE_VERIFY_FAILED') =>
  typeof error?.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code) ? error.code : fallback;
function fail(code) {
  throw Object.assign(new Error(code), { code });
}
function check(condition, code) {
  if (!condition) fail(code);
}
const summary = {
  schema: 1,
  runId,
  mode: execute ? 'execute' : 'preflight',
  status: 'BLOCKED',
  startedAt: new Date().toISOString(),
  model: 'gemini-3.8-flash',
  protocol: 'vertex-gemini-v1',
  endpointOrigin: 'https://aiplatform.googleapis.com',
  preflight: {},
  scenarios: {},
  samples: [],
  requests: [],
  restarts: [],
  failures: [],
  limitations: [
    'Metadata-only environment check; credentials are not read and authentication is not attempted.',
    'The previous paid scenarios used removed chat prompt references and chunk/anchor translation checks. They cannot establish the current whole-source/refusal-classifier contract.',
    'environmentReady is independent of execution authorization and evaluation-contract readiness; --execute remains BLOCKED.',
    'Historical live evidence is preserved. A new live evaluation plan and explicit execution approval are separate work.',
  ],
  cleanup: { status: 'NOT_RUN', retained: [] },
};
let build;
const checks = summary.preflight;
try {
  build = await assertBuild();
  summary.identity = {
    buildId: build.buildId,
    sourceHash: build.sourceHash,
    distHash: build.distHash,
    builtAt: build.builtAt,
  };
  checks.build = 'PASS';
} catch {
  checks.build = 'BUILD_MISSING_OR_STALE';
}
checks.requestTier =
  process.env.NR_VERTEX_REQUEST_TIER === 'flex' ? 'PASS' : 'NR_VERTEX_REQUEST_TIER_FLEX_REQUIRED';
summary.requestTier = process.env.NR_VERTEX_REQUEST_TIER ?? null;
const project = process.env.NR_VERTEX_PROJECT;
checks.project =
  typeof project === 'string' && /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]+)$/u.test(project)
    ? 'PASS'
    : 'NR_VERTEX_PROJECT_REQUIRED';
const credentialFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
checks.credentials = 'GOOGLE_APPLICATION_CREDENTIALS_FILE_REQUIRED';
if (credentialFile)
  try {
    if ((await stat(credentialFile)).isFile()) checks.credentials = 'PASS';
  } catch {
    /* Metadata only: never read or echo the credential file. */
  }
if (build) {
  try {
    const { createApp } = await import(pathToFileURL(path.join(root, 'dist/server/app.js')).href);
    check(typeof createApp === 'function', 'LIVE_BUILD_EXPORT_MISSING');
    checks.runtime = 'PASS';
  } catch (error) {
    checks.runtime = safeCode(error, 'LIVE_BUILD_INVALID');
  }
} else checks.runtime = 'REQUIRES_CURRENT_BUILD';
checks.authenticationAttempted = false;
checks.networkRequests = 0;
checks.databaseCreated = false;
checks.environmentReady = ['build', 'project', 'credentials', 'requestTier', 'runtime'].every(
  (key) => checks[key] === 'PASS'
);
checks.executionContract = 'LIVE_VERIFY_CURRENT_CONTRACT_REVIEW_REQUIRED';
checks.ready = false;
summary.failures.push(checks.executionContract);
{
  summary.status = 'BLOCKED';
  summary.finishedAt = new Date().toISOString();
  summary.cleanup = { status: 'PASS', retained: ['summary.json'], serverStarted: false };
  await json(path.join(directory, 'summary.json'), summary);
  console.log(
    JSON.stringify(
      {
        status: summary.status,
        mode: summary.mode,
        evidence: path.join(directory, 'summary.json'),
        preflight: checks,
      },
      null,
      2
    )
  );
  process.exitCode = 2;
}
