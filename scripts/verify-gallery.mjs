import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readdir, copyFile } from 'node:fs/promises';
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
  killOwned,
  removeOwned,
  artifactScan,
  canary,
} from './lib.mjs';
import { seedGallery } from './gallery/seed.mjs';
import { captureGallery } from './gallery/capture.mjs';
import { screens, themes, viewports } from './gallery/screens.mjs';
import { expectedJourneyCaptures, journeys } from './gallery/journey.mjs';

// Captures every listed screen and modal at 390/1440px in light and dark on an owned test-mode
// server, then walks the listed journeys step by step counting interactions, and records the
// principle metrics beside each capture. PASS means every capture, every journey step and the
// cleanup succeeded; an unmet metric is recorded in metrics.json and never fails the run.
async function main() {
  if (process.argv.length > 2) throw new Error('verify-gallery accepts no arguments');
  const runId = `gallery-${newId()}`,
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
    scope: 'gallery',
    screens: screens.length,
    journeysDefined: journeys.length,
    failures,
    cleanup: { status: 'NOT_RUN' },
    limitations: [
      'Synthetic prompts, packages and source text only; no private materials are copied into these captures.',
      'Local SQLite and browser captures only. No paid provider, external deployment, literary quality or physical-device IME claim.',
      'Captures and measurements support a design review; a recorded metric is evidence, not a verdict, and an unmet target does not fail this run.',
    ],
  };
  const ownership = createOwnership(directory, summary.startedAt);
  await json(path.join(directory, 'ownership.json'), ownership);
  let environmentBlocked = false,
    cancelled = false;
  const cancellationCleanup = [];
  const cancel = (signal) => {
    cancelled = true;
    failures.push(`${signal}: gallery capture cancelled`);
    for (const child of children)
      cancellationCleanup.push(
        killOwned(child).catch((error) => failures.push(`Cancellation cleanup: ${error.message}`))
      );
  };
  const assertNotCancelled = () => {
    if (cancelled) throw new Error('Gallery capture cancelled');
  };
  let shuttingDown = false;
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
    const env = localVerificationEnv({
      NR_DB: path.join(runtime, 'app.sqlite'),
      NR_INSTANCE: runId,
      NR_BUILD_ID: identity.buildId,
      NR_ARTIFACT_DIR: directory,
      NR_SECRET_CANARY: canary,
      TEMP: temp,
      TMP: temp,
    });
    const server = await startServer(env, directory, children);
    summary.server = server.ready;
    let stderrTail = '';
    server.child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-4000);
    });
    server.child.once('exit', (code, signal) => {
      summary.serverExit = {
        code,
        signal,
        at: new Date().toISOString(),
        duringCleanup: shuttingDown,
        stderrTail,
      };
    });
    ownership.children.push({ pid: server.child.pid, dbPath: env.NR_DB, url: server.ready.url });
    await json(path.join(directory, 'ownership.json'), ownership);
    assertNotCancelled();
    const log = (line) => console.error(`[gallery] ${line}`);
    const seeded = await seedGallery(server.ready.url, { log });
    summary.seed = { ids: seeded.ids, warnings: seeded.warnings };
    assertNotCancelled();
    const started = Date.now();
    const gallery = await captureGallery({
      baseUrl: server.ready.url,
      executablePath: browser,
      ids: seeded.ids,
      directory,
      log,
    });
    summary.gallery = {
      elapsedMs: Date.now() - started,
      captures: gallery.captures.length,
      expectedCaptures: screens.reduce(
        (count, screen) =>
          count +
          (screen.viewports?.length ?? Object.keys(viewports).length) *
            (screen.themes?.length ?? themes.length),
        0
      ),
      rubric: gallery.rubric,
      index: path.relative(directory, path.join(directory, 'index.html')),
      metrics: 'metrics.json',
      journeys: gallery.journeys.map((run) => ({
        journey: run.journey,
        viewport: run.viewport,
        completed: run.completed,
        steps: run.steps.length,
        interactions: run.interactions,
        elapsedMs: run.elapsedMs,
      })),
      journeyCaptures: gallery.journeys.reduce((count, run) => count + run.steps.length, 0),
      expectedJourneyCaptures: expectedJourneyCaptures(),
      journey: 'journey.json',
    };
    failures.push(...gallery.failures.map((message) => `Capture: ${message}`));
    if (gallery.captures.length !== summary.gallery.expectedCaptures)
      throw new Error(
        `Expected ${summary.gallery.expectedCaptures} captures, received ${gallery.captures.length}`
      );
    if (summary.gallery.journeyCaptures !== summary.gallery.expectedJourneyCaptures)
      throw new Error(
        `Expected ${summary.gallery.expectedJourneyCaptures} journey captures, received ${summary.gallery.journeyCaptures}`
      );
    assertNotCancelled();
    if (
      (await assertBuild()).buildId !== identity.buildId ||
      (await fingerprint()).hash !== before.hash
    )
      throw new Error('Build/source identity changed during gallery capture');
    summary.identityVerifiedAt = new Date().toISOString();
  } catch (error) {
    failures.push(error.message);
    if (/spawn EPERM|Browser executable missing/u.test(error.message)) environmentBlocked = true;
  } finally {
    shuttingDown = true;
    const cleanupErrors = [];
    if (summary.serverExit && !summary.serverExit.duringCleanup)
      failures.push(
        `Owned server exited before capture finished (code ${summary.serverExit.code}, signal ${summary.serverExit.signal}); an outside process may have killed it`
      );
    await Promise.all(cancellationCleanup);
    for (const child of children)
      try {
        await killOwned(child);
      } catch (error) {
        cleanupErrors.push(error.message);
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
        index: path.join(directory, 'index.html'),
        captures: summary.gallery?.captures ?? 0,
        journeys: summary.gallery?.journeys,
        rubric: summary.gallery?.rubric,
        failures,
      })
    );
    if (summary.status !== 'PASS') process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});
