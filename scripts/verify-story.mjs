import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { mkdir, readdir, copyFile } from 'node:fs/promises';
import { doctor } from './doctor.mjs';
import { doctorFailureState } from './doctor-result.mjs';
import {
  root,
  artifactRoot,
  newId,
  json,
  localVerificationEnv,
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
} from './lib.mjs';

/** Same real reporter and process ownership contract as M0/M1, with separate live-quality claims. */
export async function verifyStory(selection) {
  const runId = 'm2-' + newId();
  const directory = path.join(artifactRoot, runId);
  const runtime = path.join(directory, 'runtime');
  await mkdir(runtime, { recursive: true });
  const children = new Set();
  const failures = [];
  const requiredBrowser = ['S01', 'S02', 'S04', 'S06', 'S07'];
  let environmentBlocked = false;
  const summary = {
    schema: 1,
    runId,
    status: 'FAIL',
    scope: selection,
    startedAt: new Date().toISOString(),
    environment: { platform: process.platform, os: os.release(), node: process.version },
    commands: [],
    reports: {},
    scenarios: Object.fromEntries(
      selection.cases.map((id) => [id, { required: true, status: 'NOT_RUN', evidence: [] }])
    ),
    externalClaims: {
      Q04: {
        status: 'BLOCKED',
        reason:
          'Live state/context semantics, longitudinal quality and total paid cost require an approved evaluation scope; this verifier uses synthetic local data only.',
      },
      nativePort: {
        status: 'SEPARATE_EVIDENCE',
        reason:
          'Phēmē, Hinano and Hidden Story were supplied; the user authorized a nonsexual Hinano adaptation. Actual local import and native UI evidence are tracked separately in project-plan/NATIVE-PORTING.md and CURRENT.md. This synthetic M2 runner does not certify that evidence.',
      },
    },
    limitations: [
      'Local state/context fixtures and localhost protocols do not establish live semantic quality.',
      'Long synthetic corpus and measured fixture paths do not establish whole-app performance or physical-device latency.',
    ],
    failures,
    cleanup: { status: 'NOT_RUN' },
  };
  const owner = { runId, ownerPid: process.pid, root, directory, active: true, children: [] };
  await json(path.join(directory, 'ownership.json'), owner);
  const cancel = (signal) => {
    failures.push(signal + ': verification cancelled');
    for (const child of children)
      void killOwned(child).catch((error) => failures.push(error.message));
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const run = async (args, name, env = {}, timeout = 180000) => {
    const result = await command(args, {
      env,
      timeout,
      children,
      log: path.join(directory, name + '.log'),
    });
    const { output, ...record } = result;
    summary.commands.push({ ...record, log: name + '.log' });
    requireCommand(result);
  };
  try {
    const diagnostic = await doctor(directory);
    summary.environment.doctor = diagnostic;
    if (diagnostic.status !== 'PASS') {
      const failure = doctorFailureState(diagnostic);
      environmentBlocked = failure.status === 'BLOCKED';
      for (const scenario of Object.values(summary.scenarios)) scenario.status = failure.status;
      throw new Error('Environment doctor ' + diagnostic.status + ': ' + diagnostic.error);
    }
    await run(['node_modules/typescript/bin/tsc', '--noEmit'], 'check');
    await run(['scripts/build.mjs'], 'build');
    summary.identity = await assertBuild();
    summary.verificationIdentity = await fingerprint();
    const temp = path.join(runtime, 'temp');
    await mkdir(temp, { recursive: true });
    const env = localVerificationEnv({
      NR_DB: path.join(runtime, 'app.sqlite'),
      NR_INSTANCE: runId,
      NR_BUILD_ID: summary.identity.buildId,
      NR_ARTIFACT_DIR: directory,
      NR_BROWSER_OUTPUT: path.join(directory, 'browser'),
      TEMP: temp,
      TMP: temp,
      ...(browserPath() ? { NR_BROWSER_PATH: browserPath() } : {}),
    });
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
    const unitPattern = new RegExp(`\\b(${selection.cases.join('|')})\\b`);
    let since = Date.now();
    let executionError;
    try {
      await run(
        [
          'node_modules/vitest/vitest.mjs',
          'run',
          '--reporter=json',
          `--outputFile=${path.join(directory, 'vitest.json')}`,
          '-t',
          unitPattern.source,
        ],
        'vitest',
        env
      );
    } catch (error) {
      executionError = error;
    }
    try {
      summary.reports.vitest = await readReport(
        path.join(directory, 'vitest.json'),
        since,
        'vitest',
        unitPattern
      );
    } catch (error) {
      summary.reports.vitest = error.observations ?? { status: 'FAIL', error: error.message };
      throw error;
    }
    if (executionError) throw executionError;
    const browserCases = selection.cases.filter((id) => requiredBrowser.includes(id));
    if (browserCases.length) {
      since = Date.now();
      executionError = undefined;
      try {
        await run(
          [
            'node_modules/@playwright/test/cli.js',
            'test',
            'tests/story-browser.spec.ts',
            '--reporter=json',
            '--grep',
            browserCases.join('|'),
          ],
          'playwright',
          { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(directory, 'playwright.json') }
        );
      } catch (error) {
        executionError = error;
      }
      try {
        summary.reports.playwright = await readReport(
          path.join(directory, 'playwright.json'),
          since,
          'playwright'
        );
      } catch (error) {
        summary.reports.playwright = error.observations ?? { status: 'FAIL', error: error.message };
        throw error;
      }
      if (executionError) throw executionError;
    }
    for (const id of selection.cases) {
      const matches = (test) => new RegExp(`\\b${id}\\b`).test(test.title);
      const unit = summary.reports.vitest.tests.filter(matches);
      const browser = summary.reports.playwright?.tests.filter(matches) ?? [];
      if (!unit.length || (requiredBrowser.includes(id) && !browser.length))
        throw new Error(id + ': zero required reporter evidence');
      summary.scenarios[id] = {
        required: true,
        status: 'PASS',
        evidence: [...unit, ...browser].map((test) => test.title),
        reporters: ['vitest.json', ...(browser.length ? ['playwright.json'] : [])],
      };
    }
    if (selection.cases.includes('S07') && process.env.NR_BENCHMARK === '1') {
      if (!existsSync(path.join(directory, 'story-performance.json')))
        throw new Error('S07 performance measurements missing');
      summary.scenarios.S07.measurements = 'story-performance.json';
    }
    await assertBuild();
    if ((await fingerprint()).hash !== summary.verificationIdentity.hash)
      throw new Error('Source changed during verification');
  } catch (error) {
    failures.push(error.message);
  } finally {
    const cleanupErrors = [];
    const terminated = [];
    for (const child of children)
      try {
        terminated.push(await killOwned(child));
      } catch (error) {
        cleanupErrors.push(error.message);
      }
    const live = [...children].filter(
      (child) => child.pid && child.exitCode === null && child.signalCode === null
    );
    try {
      // biome-ignore lint/correctness/noUnsafeFinally: The local catch records cleanup failure alongside prior failures and retains the live runtime.
      if (live.length) throw new Error('Owned children still running; runtime retained');
      const evidence = path.join(directory, 'evidence-db');
      await mkdir(evidence, { recursive: true });
      for (const name of await readdir(runtime))
        if (/\.sqlite(?:-wal|-shm)?$/.test(name))
          await copyFile(path.join(runtime, name), path.join(evidence, name));
      await removeOwned(directory, runtime);
    } catch (error) {
      cleanupErrors.push(error.message);
    }
    summary.cleanup = {
      status: cleanupErrors.length ? 'FAIL' : 'PASS',
      terminated,
      livePids: live.map((child) => child.pid),
      errors: cleanupErrors,
    };
    failures.push(...cleanupErrors);
    owner.active = live.length > 0;
    owner.finishedAt = new Date().toISOString();
    owner.cleanup = summary.cleanup;
    await json(path.join(directory, 'ownership.json'), owner);
    try {
      summary.artifactScan = await artifactScan(directory);
    } catch (error) {
      failures.push(error.message);
    }
    if (failures.length)
      for (const scenario of Object.values(summary.scenarios)) {
        scenario.evidenceInvalid = true;
        if (scenario.status === 'NOT_RUN') scenario.status = 'FAIL';
      }
    summary.localStatus =
      environmentBlocked && summary.cleanup.status === 'PASS'
        ? 'BLOCKED'
        : failures.length
          ? 'FAIL'
          : Object.values(summary.scenarios).every((scenario) => scenario.status === 'PASS')
            ? 'PASS'
            : 'FAIL';
    summary.status =
      summary.localStatus === 'PASS' && selection.milestone === 'M2'
        ? 'BLOCKED'
        : summary.localStatus;
    summary.finishedAt = new Date().toISOString();
    await json(path.join(directory, 'summary.json'), summary);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    console.log(
      JSON.stringify(
        {
          status: summary.status,
          runId,
          evidence: path.join(directory, 'summary.json'),
          scenarios: Object.fromEntries(
            Object.entries(summary.scenarios).map(([id, result]) => [id, result.status])
          ),
          failures,
        },
        null,
        2
      )
    );
    if (summary.status !== 'PASS') process.exitCode = 1;
  }
}
