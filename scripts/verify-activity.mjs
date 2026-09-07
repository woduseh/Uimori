import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readdir, copyFile, readFile } from 'node:fs/promises';
import {
  root,
  artifactRoot,
  newId,
  json,
  command,
  requireCommand,
  assertBuild,
  fingerprint,
  startServer,
  killOwned,
  readReport,
  browserPath,
  removeOwned,
  artifactScan,
  canary,
  filesBelow,
} from './lib.mjs';

// Reuse the repository ownership, build identity, fresh reporter and cleanup contracts.
// Run only after npm run build on a stable source tree.
async function main() {
  if (process.argv.length > 2) throw new Error('verify-activity accepts no arguments');
  const runId = `activity-ui-${newId()}`,
    directory = path.join(artifactRoot, runId),
    runtime = path.join(directory, 'runtime');
  const children = new Set(),
    failures = [];
  let cancelled = false,
    blocked = false;
  const requiredCases = ['ACTUI01', 'ACTUI02', 'ACTUI03', 'ACTUI04'];
  const requiredScreenshots = ['activity-desktop.png', 'activity-mobile.png'];
  const summary = {
    schema: 1,
    runId,
    status: 'FAIL',
    scope:
      'Synthetic reader activity timers, collapse, completion expiry, failures and mobile layout',
    startedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform },
    commands: [],
    reports: {},
    failures,
    requiredCases,
    requiredScreenshots,
    cleanup: { status: 'NOT_RUN' },
    limitations: [
      'No provider catalog lookup, paid generation, user DB, or deployment.',
      '390px is a browser viewport; physical phone keyboard and IME behavior are not established.',
      'Screenshots require visual review; automated assertions check control bounds and persisted values.',
      'This runner does not replace provider codec, loopback transport, M0 or M1-local verification.',
    ],
  };
  const owner = {
    runId,
    ownerPid: process.pid,
    root,
    directory,
    active: true,
    children: [],
    startedAt: summary.startedAt,
  };
  await mkdir(path.join(runtime, 'temp'), { recursive: true });
  await json(path.join(directory, 'ownership.json'), owner);
  const cancel = (signal) => {
    cancelled = true;
    failures.push(`Cancelled: ${signal}`);
    for (const child of children)
      void killOwned(child).catch((error) => failures.push(error.message));
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const [major, minor] = process.versions.node.split('.').map(Number),
      executable = browserPath();
    if (major !== 24 || minor < 14 || !executable || !existsSync(executable)) {
      blocked = true;
      throw new Error('Supported Node 24.14+ and local browser executable are required');
    }
    summary.environment.browser = executable;
    summary.identity = await assertBuild();
    const initial = await fingerprint();
    if (initial.hash !== summary.identity.sourceHash)
      throw new Error('Source changed during initial identity check');
    const env = {
      NR_DB: path.join(runtime, 'app.sqlite'),
      NR_PORT: '0',
      NR_INSTANCE: runId,
      NR_BUILD_ID: summary.identity.buildId,
      NR_TEST_MODE: '1',
      NR_ACCESS_TOKEN: '',
      NR_PROVIDER_ORIGINS: '',
      NR_ARTIFACT_DIR: directory,
      NR_BROWSER_OUTPUT: path.join(directory, 'browser'),
      NR_SECRET_CANARY: canary,
      NR_BROWSER_PATH: executable,
      TEMP: path.join(runtime, 'temp'),
      TMP: path.join(runtime, 'temp'),
    };
    if (cancelled) throw new Error('Cancelled before server start');
    const server = await startServer(env, directory, children);
    env.NR_BASE_URL = server.ready.url;
    summary.server = server.ready;
    owner.children = [
      {
        pid: server.child.pid,
        command: 'node dist/server/index.js',
        dbPath: env.NR_DB,
        url: env.NR_BASE_URL,
      },
    ];
    await json(path.join(directory, 'ownership.json'), owner);
    const reportFile = path.join(directory, 'playwright.json'),
      since = Date.now();
    const result = await command(
      [
        'node_modules/@playwright/test/cli.js',
        'test',
        'tests/activity-browser.spec.ts',
        '--reporter=json',
      ],
      {
        env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile },
        timeout: 180000,
        children,
        log: path.join(directory, 'playwright.log'),
      }
    );
    const { output, ...record } = result;
    summary.commands.push({ ...record, log: 'playwright.log' });
    // Parse even after command failure so incomplete/missing evidence remains visible.
    try {
      summary.reports.playwright = await readReport(reportFile, since, 'playwright');
    } catch (error) {
      summary.reports.playwright = error.observations ?? { status: 'FAIL', error: error.message };
      failures.push(error.message);
    }
    requireCommand(result);
    const report = summary.reports.playwright;
    for (const id of requiredCases)
      if (
        !report.tests?.some(
          (item) => new RegExp(`\\b${id}\\b`).test(item.title) && item.status === 'passed'
        )
      )
        throw new Error(`Missing passing evidence: ${id}`);
    const screenshots = (await filesBelow(env.NR_BROWSER_OUTPUT)).filter((file) =>
      file.endsWith('.png')
    );
    for (const name of requiredScreenshots) {
      const file = screenshots.find((file) => path.basename(file) === name);
      if (!file) throw new Error(`Missing screenshot: ${name}`);
      const bytes = await readFile(file);
      if (
        bytes.length < 24 ||
        !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw new Error(`Invalid screenshot: ${name}`);
    }
    summary.screenshots = screenshots.map((file) => path.relative(directory, file));
    const final = await assertBuild();
    if (final.buildId !== summary.identity.buildId || (await fingerprint()).hash !== initial.hash)
      throw new Error('Source/build changed during activity UI verification');
    summary.identityVerifiedAt = new Date().toISOString();
  } catch (error) {
    failures.push(error.message);
  } finally {
    const errors = [],
      terminated = [];
    for (const child of children)
      try {
        terminated.push(await killOwned(child));
      } catch (error) {
        errors.push(error.message);
      }
    const live = [...children].filter(
      (child) => child.pid && child.exitCode === null && child.signalCode === null
    );
    if (live.length) errors.push('Owned children remain alive; runtime retained');
    if (!live.length)
      try {
        const evidence = path.join(directory, 'evidence-db');
        await mkdir(evidence, { recursive: true });
        for (const name of await readdir(runtime))
          if (/\.sqlite(?:-wal|-shm)?$/.test(name))
            await copyFile(path.join(runtime, name), path.join(evidence, name));
        await removeOwned(directory, runtime);
      } catch (error) {
        errors.push(error.message);
      }
    summary.cleanup = {
      status: errors.length ? 'FAIL' : 'PASS',
      terminated,
      livePids: live.map((child) => child.pid),
      runtimeRemoved: !existsSync(runtime),
      retained: ['evidence-db', 'reporter and logs', 'browser screenshots/traces'],
      errors,
    };
    failures.push(...errors);
    owner.active = live.length > 0;
    owner.finishedAt = new Date().toISOString();
    owner.cleanup = summary.cleanup;
    await json(path.join(directory, 'ownership.json'), owner);
    try {
      summary.artifactScan = await artifactScan(directory);
    } catch (error) {
      failures.push(error.message);
      summary.artifactScan = { status: 'FAIL', error: error.message };
    }
    if (summary.identity && !summary.identityVerifiedAt)
      summary.evidenceIdentity = 'NOT_CONFIRMED_AT_END';
    summary.status = failures.length ? (blocked ? 'BLOCKED' : 'FAIL') : 'PASS';
    summary.finishedAt = new Date().toISOString();
    await json(path.join(directory, 'summary.json'), summary);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    console.log(
      JSON.stringify(
        { status: summary.status, evidence: path.join(directory, 'summary.json'), failures },
        null,
        2
      )
    );
    if (summary.status !== 'PASS') process.exitCode = 1;
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 2;
});
