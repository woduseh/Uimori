import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readdir, copyFile } from 'node:fs/promises';
import { artifactRoot, newId, json, assertBuild, fingerprint, browserPath, startServer, command, readReport, requireCommand, killOwned, removeOwned, artifactScan, canary } from './lib.mjs';

if (process.argv.length > 2) throw new Error('verify-native-ui accepts no arguments');
const runId = `native-ui-${newId()}`, directory = path.join(artifactRoot, runId), runtime = path.join(directory, 'runtime');
await mkdir(runtime, { recursive: true });
const children = new Set(), failures = [];
const summary = { runId, status: 'FAIL', startedAt: new Date().toISOString(), scope: 'Native UI synthetic isolated browser smoke', failures, limitations: [
  'Synthetic packages and source text only; no private Phēmē, bot or hidden-story bodies are copied into these tests.',
  'Local SQLite and browser actions only. No paid provider, external deployment, literary quality or physical-device IME claim.',
  'Screenshots support visual inspection; their existence alone does not establish visual correctness.',
] };
const ownership = { runId, root: directory, active: true, children: [], startedAt: summary.startedAt };
await json(path.join(directory, 'ownership.json'), ownership);
let environmentBlocked = false;
const cancel = signal => { failures.push(`${signal}: native UI cancelled`); for (const child of children) void killOwned(child).catch(error => failures.push(error.message)); };
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
try {
  const browser = browserPath();
  if (!browser || !existsSync(browser)) { environmentBlocked = true; throw new Error('Local test browser unavailable'); }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 14) { environmentBlocked = true; throw new Error('Node >=24.14.0 <25 required'); }
  const identity = await assertBuild(), before = await fingerprint(); summary.identity = identity;
  const temp = path.join(runtime, 'temp'); await mkdir(temp, { recursive: true });
  const env = { NR_DB: path.join(runtime, 'native.sqlite'), NR_PORT: '0', NR_INSTANCE: runId, NR_BUILD_ID: identity.buildId, NR_TEST_MODE: '1', NR_ACCESS_TOKEN: '', NR_PROVIDER_ORIGINS: '', NR_ARTIFACT_DIR: directory, NR_BROWSER_OUTPUT: path.join(directory, 'browser'), NR_SECRET_CANARY: canary, NR_BROWSER_PATH: browser, TEMP: temp, TMP: temp };
  const server = await startServer(env, directory, children); env.NR_BASE_URL = server.ready.url; summary.server = server.ready;
  ownership.children.push({ pid: server.child.pid, dbPath: env.NR_DB, url: server.ready.url }); await json(path.join(directory, 'ownership.json'), ownership);
  const reporter = path.join(directory, 'playwright.json'), since = Date.now();
  const result = await command(['node_modules/@playwright/test/cli.js', 'test', 'tests/native-browser.spec.ts', '--reporter=json'], { env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: reporter }, timeout: 180_000, log: path.join(directory, 'playwright.log'), children });
  const { output: _output, ...record } = result; summary.command = record;
  try { summary.report = await readReport(reporter, since, 'playwright'); } catch (error) { summary.report = error.observations; throw error; }
  requireCommand(result);
  for (const id of ['NUI01', 'NUI02', 'NUI03']) if (!summary.report.tests.some(test => test.status === 'passed' && test.title.includes(id))) throw new Error(`Missing ${id} evidence`);
  if ((await assertBuild()).buildId !== identity.buildId || (await fingerprint()).hash !== before.hash) throw new Error('Build/source identity changed during native UI verification');
  summary.identityVerifiedAt = new Date().toISOString();
} catch (error) { failures.push(error.message); if (/spawn EPERM|Browser executable missing/u.test(error.message)) environmentBlocked = true; }
finally {
  const cleanupErrors = [];
  for (const child of children) try { await killOwned(child); } catch (error) { cleanupErrors.push(error.message); }
  const live = [...children].filter(child => child.pid && child.exitCode === null && child.signalCode === null);
  if (live.length) cleanupErrors.push('Owned child process still running; runtime retained');
  try {
    if (!live.length) {
      const evidence = path.join(directory, 'evidence-db'); await mkdir(evidence, { recursive: true });
      for (const name of await readdir(runtime)) if (/\.sqlite(?:-wal|-shm)?$/u.test(name)) await copyFile(path.join(runtime, name), path.join(evidence, name));
      await removeOwned(directory, runtime);
    }
  } catch (error) { cleanupErrors.push(error.message); }
  summary.cleanup = { status: cleanupErrors.length ? 'FAIL' : 'PASS', livePids: live.map(child => child.pid), errors: cleanupErrors, runtimeRemoved: !existsSync(runtime) };
  failures.push(...cleanupErrors); ownership.active = live.length > 0; ownership.finishedAt = new Date().toISOString(); await json(path.join(directory, 'ownership.json'), ownership);
  try { summary.artifactScan = await artifactScan(directory); } catch (error) { failures.push(error.message); }
  summary.status = failures.length ? environmentBlocked ? 'BLOCKED' : 'FAIL' : 'PASS'; summary.finishedAt = new Date().toISOString();
  await json(path.join(directory, 'summary.json'), summary);
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  console.log(JSON.stringify({ status: summary.status, runId, evidence: path.join(directory, 'summary.json'), tests: summary.report?.passed ?? 0, failures }));
  if (summary.status !== 'PASS') process.exitCode = 1;
}
