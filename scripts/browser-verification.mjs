import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readdir, copyFile, readFile } from 'node:fs/promises';
import { startProviderFixture } from './provider-management-fixture.mjs';
import {
  artifactRoot,
  newId,
  json,
  createOwnership,
  localVerificationEnv,
  assertBuild,
  buildFingerprint,
  fingerprint,
  browserPath,
  startServer,
  command,
  readReport,
  requireCommand,
  killOwned,
  removeOwned,
  artifactScan,
  canary,
  filesBelow,
} from './lib.mjs';

// The entry points select tests; this owns their shared evidence and cleanup contract.
export async function runBrowserVerification({
  name,
  prefix = name,
  scope,
  files = [],
  grep,
  requiredCases = [],
  requiredTitles = [],
  requiredScreenshots = [],
  expectedCount,
  providerFixture = false,
  timeout = 600_000,
  limitations = [],
}) {
  if (process.argv.length > 2) throw new Error(`verify-${name} accepts no arguments`);
  const visualReview = process.env.NR_VISUAL_REVIEW === '1';
  const runId = `${prefix}-${newId()}`,
    directory = path.join(artifactRoot, runId),
    runtime = path.join(directory, 'runtime');
  await mkdir(runtime, { recursive: true });
  const children = new Set(),
    failures = [];
  const summary = {
    schema: 1,
    runId,
    status: 'FAIL',
    startedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform },
    scope,
    requiredCases,
    requiredTitles,
    visualReview,
    requiredScreenshots: visualReview ? requiredScreenshots : [],
    failures,
    cleanup: { status: 'NOT_RUN' },
    limitations: [
      'Synthetic prompts, packages and source text only; no private materials are copied into these tests.',
      'Local SQLite and browser actions only. No paid provider, external deployment, literary quality or physical-device IME claim.',
      'Screenshots support visual inspection; their existence alone does not establish visual correctness.',
      ...limitations,
    ],
  };
  const ownership = createOwnership(directory, summary.startedAt);
  await json(path.join(directory, 'ownership.json'), ownership);
  let environmentBlocked = false,
    cancelled = false,
    fixture;
  const cancellationCleanup = [];
  const cancel = (signal) => {
    cancelled = true;
    failures.push(`${signal}: ${name} verification cancelled`);
    for (const child of children)
      cancellationCleanup.push(
        killOwned(child).catch((error) => failures.push(`Cancellation cleanup: ${error.message}`))
      );
  };
  const assertNotCancelled = () => {
    if (cancelled) throw new Error('Verification cancelled');
  };
  const onInterrupt = () => cancel('SIGINT');
  const onTerminate = () => cancel('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  try {
    const browser = browserPath();
    if (!browser || !existsSync(browser)) {
      environmentBlocked = true;
      throw new Error('Local test browser unavailable');
    }
    summary.environment.browser = browser;
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major !== 24 || minor < 14) {
      environmentBlocked = true;
      throw new Error('Node >=24.14.0 <25 required');
    }
    const identity = await assertBuild(),
      before = await fingerprint();
    summary.identity = identity;
    summary.verificationIdentity = before;
    if (identity.sourceHash !== (await buildFingerprint()).hash)
      throw new Error('Source changed during initial build identity check');
    const temp = path.join(runtime, 'temp');
    await mkdir(temp, { recursive: true });
    assertNotCancelled();
    if (providerFixture) fixture = await startProviderFixture();
    const env = localVerificationEnv({
      NR_DB: path.join(runtime, 'app.sqlite'),
      NR_INSTANCE: runId,
      NR_BUILD_ID: identity.buildId,
      NR_PROVIDER_ORIGINS: fixture ? new URL(fixture.url).origin : '',
      ...(fixture ? { NR_PROVIDER_FIXTURE_URL: fixture.url } : {}),
      NR_ARTIFACT_DIR: directory,
      NR_BROWSER_OUTPUT: path.join(directory, 'browser'),
      NR_SECRET_CANARY: canary,
      NR_BROWSER_PATH: browser,
      TEMP: temp,
      TMP: temp,
    });
    assertNotCancelled();
    const server = await startServer(env, directory, children);
    env.NR_BASE_URL = server.ready.url;
    summary.server = server.ready;
    ownership.children.push({ pid: server.child.pid, dbPath: env.NR_DB, url: server.ready.url });
    await json(path.join(directory, 'ownership.json'), ownership);
    assertNotCancelled();
    const reporter = path.join(directory, 'playwright.json'),
      since = Date.now();
    const result = await command(
      [
        'node_modules/@playwright/test/cli.js',
        'test',
        ...files,
        ...(grep ? ['--grep', grep] : []),
        '--reporter=json',
      ],
      {
        env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: reporter },
        timeout,
        log: path.join(directory, 'playwright.log'),
        children,
      }
    );
    const { output: _output, ...record } = result;
    summary.command = record;
    // Preserve both the command failure and the reporter observations.
    try {
      summary.report = await readReport(reporter, since, 'playwright');
    } catch (error) {
      summary.report = error.observations ?? { status: 'FAIL', error: error.message };
      failures.push(error.message);
    }
    requireCommand(result);
    if (failures.length) throw new Error('Required browser evidence is not PASS');
    for (const id of requiredCases)
      if (!summary.report.tests.some((test) => test.title.split(/\s+/u).includes(id)))
        throw new Error(`Missing ${id} evidence`);
    for (const title of requiredTitles)
      if (!summary.report.tests.some((test) => test.title.trimEnd().endsWith(` ${title}`)))
        throw new Error(`Missing required browser assertion: ${title}`);
    if (expectedCount !== undefined && summary.report.executed !== expectedCount)
      throw new Error(
        `Expected ${expectedCount} browser tests, received ${summary.report.executed}`
      );
    if (visualReview && requiredScreenshots.length) {
      const screenshots = (await filesBelow(env.NR_BROWSER_OUTPUT)).filter((file) =>
        file.endsWith('.png')
      );
      summary.screenshots = screenshots.map((file) => path.relative(directory, file));
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
    }
    assertNotCancelled();
    if (
      (await assertBuild()).buildId !== identity.buildId ||
      (await fingerprint()).hash !== before.hash
    )
      throw new Error(`Build/source identity changed during ${name} verification`);
    summary.identityVerifiedAt = new Date().toISOString();
  } catch (error) {
    failures.push(error.message);
    if (/spawn EPERM|Browser executable missing/u.test(error.message)) environmentBlocked = true;
  } finally {
    const cleanupErrors = [];
    await Promise.all(cancellationCleanup);
    for (const child of children)
      try {
        await killOwned(child);
      } catch (error) {
        cleanupErrors.push(error.message);
      }
    if (fixture)
      try {
        await fixture.close();
      } catch (error) {
        cleanupErrors.push(error.message);
      } finally {
        summary.providerFixture = fixture.stats();
        failures.push(...summary.providerFixture.errors.map((message) => `Fixture: ${message}`));
      }
    const live = [...children].filter(
      (child) => child.pid && child.exitCode === null && child.signalCode === null
    );
    if (live.length) cleanupErrors.push('Owned child process still running; runtime retained');
    try {
      if (!live.length) {
        const evidence = path.join(directory, 'evidence-db');
        await mkdir(evidence, { recursive: true });
        for (const entry of await readdir(runtime))
          if (/\.sqlite(?:-wal|-shm)?$/u.test(entry))
            await copyFile(path.join(runtime, entry), path.join(evidence, entry));
        await removeOwned(directory, runtime);
      }
    } catch (error) {
      cleanupErrors.push(error.message);
    }
    summary.cleanup = {
      status: cleanupErrors.length ? 'FAIL' : 'PASS',
      livePids: live.map((child) => child.pid),
      errors: cleanupErrors,
      runtimeRemoved: !existsSync(runtime),
    };
    failures.push(...cleanupErrors.map((message) => `Cleanup: ${message}`));
    ownership.active = live.length > 0;
    ownership.finishedAt = new Date().toISOString();
    ownership.cleanup = summary.cleanup;
    await json(path.join(directory, 'ownership.json'), ownership);
    try {
      summary.artifactScan = await artifactScan(directory);
    } catch (error) {
      failures.push(error.message);
      summary.artifactScan = { status: 'FAIL', error: error.message };
    }
    // All evidence and owned-resource work is settled. End cancellation handling
    // before fixing the terminal status so saving it cannot race a late handler.
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    await Promise.all(cancellationCleanup);
    if (summary.identity && !summary.identityVerifiedAt)
      summary.evidenceIdentity = 'NOT_CONFIRMED_AT_END';
    summary.status = failures.length ? (environmentBlocked ? 'BLOCKED' : 'FAIL') : 'PASS';
    summary.finishedAt = new Date().toISOString();
    await json(path.join(directory, 'summary.json'), summary);
    console.log(
      JSON.stringify({
        status: summary.status,
        runId,
        evidence: path.join(directory, 'summary.json'),
        tests: summary.report?.passed ?? 0,
        failures,
      })
    );
    if (summary.status !== 'PASS') process.exitCode = 1;
  }
  return { directory, summary };
}
