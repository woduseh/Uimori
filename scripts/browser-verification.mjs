import { retainArtifacts } from './artifact-retention.mjs';
import { parseShard, browserCases } from './ci-summary.mjs';
import { assertBrowserRuntime } from './browser-runtime.mjs';
import { requiredNode, supportedNode } from './node-runtime.mjs';
import path from 'node:path';
import { availableParallelism, totalmem } from 'node:os';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, readdir, copyFile, readFile } from 'node:fs/promises';
import { startProviderFixture } from './provider-management-fixture.mjs';
import { parseOptions } from './release-common.mjs';
import {
  artifactRoot,
  newId,
  root,
  json,
  createOwnership,
  localVerificationEnv,
  assertBuild,
  browserPath,
  startServer,
  command,
  readBrowserReport,
  requireCommand,
  killOwned,
  removeOwned,
  artifactScan,
  canary,
  filesBelow,
} from './lib.mjs';

const workerMemory = 2 ** 31;

export function defaultBrowserWorkers({ cpus = availableParallelism(), memory = totalmem() } = {}) {
  return Math.max(1, Math.min(Math.floor(cpus / 2), Math.floor(memory / workerMemory)));
}

export function parseBrowserWorkers(value) {
  if (!/^[1-9]\d?$/u.test(value ?? '')) throw new Error('Use a worker count from 1 to 99');
  return Number(value);
}

function parseRepeatEach(value) {
  if (!/^[1-9]\d{0,2}$/u.test(value ?? '')) throw new Error('Use a repeat count from 1 to 999');
  return Number(value);
}

const browserTurnPort = 47613;

export async function waitForBrowserTurn({
  port = browserTurnPort,
  retryDelay = 2000,
  cancelled = () => false,
  announce = (message) => console.error(message),
} = {}) {
  for (let announced = false; ; ) {
    const holder = createServer();
    const held = await new Promise((resolve, reject) => {
      holder.once('error', (error) =>
        error.code === 'EADDRINUSE' ? resolve(false) : reject(error)
      );
      holder.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve(true));
    });
    if (held) return () => new Promise((resolve) => holder.close(resolve));
    if (cancelled()) throw new Error('Verification cancelled');
    if (!announced) {
      announced = true;
      announce(
        'Another browser verification is running on this machine. Waiting for it to finish; concurrent runs time out each other.'
      );
    }
    await delay(retryDelay);
  }
}

export async function runBrowserVerification({
  name,
  prefix = name,
  scope,
  files = [],
  grep,
  providerFixture = false,
  privateMaterials = false,
  timeout = 600_000,
  limitations = [],
}) {
  const options = parseOptions(process.argv.slice(2), {
    values: ['grep', 'shard', 'workers', 'repeat-each'],
    flags: ['visual'],
  });
  if (options.shard) parseShard(options.shard);
  const repeatEach =
    options['repeat-each'] === undefined ? 1 : parseRepeatEach(options['repeat-each']);
  const requestedWorkers = options.workers ?? process.env.UIMORI_BROWSER_WORKERS;
  const workers = Math.min(
    requestedWorkers === undefined
      ? defaultBrowserWorkers()
      : parseBrowserWorkers(requestedWorkers),
    files.length * repeatEach || Number.POSITIVE_INFINITY
  );
  const focused = options.grep !== undefined;
  if (focused) {
    new RegExp(options.grep);
    grep = grep ? `(?=[\\s\\S]*(?:${grep}))(?=[\\s\\S]*(?:${options.grep}))` : options.grep;
  }
  const visualReview = options.visual || process.env.UIMORI_VISUAL_REVIEW === '1';
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
    selection: { files, grep, focused, ...(options.shard ? { shard: options.shard } : {}) },
    commit: process.env.GITHUB_SHA ?? null,
    workers,
    visualReview,
    failures,
    cleanup: { status: 'NOT_RUN' },
    limitations: [
      privateMaterials
        ? 'Explicitly opted-in private local materials are read without modification. Screenshots and failure traces may contain private rendered content; no original files are added to the repository.'
        : 'Synthetic prompts, packages and source text only; no private materials are copied into these tests.',
      'Local SQLite and browser actions only. No paid provider, external deployment, literary quality or physical-device IME claim.',
      'Screenshots support visual inspection; their existence alone does not establish visual correctness.',
      ...limitations,
    ],
  };
  const ownership = createOwnership(directory, summary.startedAt);
  await json(path.join(directory, 'ownership.json'), ownership);
  let environmentBlocked = false,
    cancelled = false,
    fixture,
    endBrowserTurn;
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
    if (!supportedNode()) {
      environmentBlocked = true;
      throw new Error(`Node ${requiredNode} required`);
    }
    endBrowserTurn = await waitForBrowserTurn({ cancelled: () => cancelled });
    summary.turnStartedAt = new Date().toISOString();
    const identity = await assertBuild();
    summary.environment.browserRuntime = await assertBrowserRuntime({ executablePath: browser });
    summary.identity = identity;
    const temp = path.join(runtime, 'temp');
    await mkdir(temp, { recursive: true });
    assertNotCancelled();
    if (providerFixture) fixture = await startProviderFixture();
    const env = localVerificationEnv({
      UIMORI_BUILD_ID: identity.buildId,
      ...(fixture ? { UIMORI_PROVIDER_FIXTURE_URL: fixture.url } : {}),
      UIMORI_ARTIFACT_DIR: directory,
      UIMORI_BROWSER_OUTPUT: path.join(directory, 'browser'),
      UIMORI_SECRET_CANARY: canary,
      UIMORI_BROWSER_PATH: browser,
      UIMORI_VISUAL_REVIEW: visualReview ? '1' : '0',
      UIMORI_PRIVATE_MATERIALS: privateMaterials ? '1' : '0',
      TEMP: temp,
      TMP: temp,
    });
    assertNotCancelled();
    const servers = await Promise.all(
      Array.from({ length: workers }, async (_, index) => {
        const worker = index + 1,
          log = path.join(directory, 'servers', String(worker));
        await mkdir(log, { recursive: true });
        const serverEnv = {
          ...env,
          UIMORI_DB: path.join(runtime, `app-${worker}.sqlite`),
          UIMORI_INSTANCE: `${runId}-${worker}`,
        };
        const server = await startServer(serverEnv, log, children);
        ownership.children.push({
          pid: server.child.pid,
          dbPath: serverEnv.UIMORI_DB,
          url: server.ready.url,
        });
        return { worker, url: server.ready.url, db: serverEnv.UIMORI_DB, ready: server.ready };
      })
    );
    summary.servers = servers.map(({ worker, ready }) => ({ worker, ...ready }));
    env.UIMORI_BROWSER_SERVERS = JSON.stringify(servers.map(({ url, db }) => ({ url, db })));
    await json(path.join(directory, 'ownership.json'), ownership);
    assertNotCancelled();
    if (options.shard) {
      const inventory = path.join(directory, 'collection.json');
      requireCommand(
        await command(
          [
            'node_modules/@playwright/test/cli.js',
            'test',
            ...files,
            ...(grep ? ['--grep', grep] : []),
            '--list',
            '--reporter=json',
          ],
          {
            env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: inventory },
            timeout: 60_000,
            log: path.join(directory, 'collection.log'),
            children,
          }
        )
      );
      summary.selection.allTests = browserCases(
        JSON.parse(await readFile(inventory, 'utf8'))
      ).sort();
      if (!summary.selection.allTests.length) throw new Error('Empty full browser collection');
    }
    const reporter = path.join(directory, 'playwright.json'),
      since = Date.now();
    const result = await command(
      [
        'node_modules/@playwright/test/cli.js',
        'test',
        ...files,
        ...(grep ? ['--grep', grep] : []),
        ...(options.shard ? [`--shard=${options.shard}`] : []),
        ...(repeatEach > 1 ? [`--repeat-each=${repeatEach}`] : []),
        '--reporter=list,json',
      ],
      {
        env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: reporter },
        timeout,
        echo: true,
        log: path.join(directory, 'playwright.log'),
        children,
      }
    );
    const { output: _output, ...record } = result;
    summary.command = record;
    try {
      summary.report = await readBrowserReport(reporter, since);
    } catch (error) {
      summary.report = error.observations ?? { status: 'FAIL', error: error.message };
      failures.push(error.message);
    }
    requireCommand(result);
    if (options.shard)
      summary.testCases = browserCases(JSON.parse(await readFile(reporter, 'utf8'))).sort();
    if (failures.length) throw new Error('Required browser evidence is not PASS');
    if (visualReview) {
      const screenshots = (await filesBelow(env.UIMORI_BROWSER_OUTPUT)).filter((file) =>
        file.endsWith('.png')
      );
      summary.screenshots = screenshots.map((file) => path.relative(directory, file));
    }
  } catch (error) {
    failures.push(error.message);
    if (
      error.code === 'BROWSER_RUNTIME_UNAVAILABLE' ||
      /spawn EPERM|Browser executable missing/u.test(error.message)
    )
      environmentBlocked = true;
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
    await endBrowserTurn?.();
    try {
      if (!live.length) {
        if (failures.length) {
          const evidence = path.join(directory, 'evidence-db');
          await mkdir(evidence, { recursive: true });
          for (const entry of await readdir(runtime))
            if (/\.sqlite(?:-wal|-shm)?$/u.test(entry))
              await copyFile(path.join(runtime, entry), path.join(evidence, entry));
        }
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
    if (failures.length) {
      try {
        summary.artifactScan = await artifactScan(directory);
        if (privateMaterials)
          summary.artifactScan.scope =
            'Known synthetic secret canary only; opted-in private rendered content may appear in artifacts. This scan does not establish the absence of real secrets or private prose.';
      } catch (error) {
        failures.push(error.message);
        summary.artifactScan = { status: 'FAIL', error: error.message };
      }
    }
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    await Promise.all(cancellationCleanup);
    summary.status = failures.length ? (environmentBlocked ? 'BLOCKED' : 'FAIL') : 'PASS';
    summary.finishedAt = new Date().toISOString();
    await json(path.join(directory, 'summary.json'), summary);
    summary.retention = await retainArtifacts({ current: directory, apply: true });
    await json(path.join(directory, 'summary.json'), summary);
    if (process.env.UIMORI_CI_BROWSER_REPORT)
      await json(path.resolve(root, process.env.UIMORI_CI_BROWSER_REPORT), summary);
    console.log(
      JSON.stringify({
        status: summary.status,
        runId,
        evidence: path.join(directory, 'summary.json'),
        tests: summary.report?.passed ?? null,
        reportComplete: Array.isArray(summary.report?.tests),
        failures,
      })
    );
    if (summary.status !== 'PASS') process.exitCode = 1;
  }
  return { directory, summary };
}
