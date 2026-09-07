import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { mkdir, readdir, copyFile } from 'node:fs/promises';
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
} from './lib.mjs';

// This verifies an already-built immutable checkout. Run npm run build first.
// M0/M1-local and human visual/performance review remain separate gates.
const requiredBrowserIds = ['UI01', 'UI02', 'UI03', 'UI04', 'UI05', 'UI08', 'UI09', 'UI10', 'UI12'];
const requiredProseTitles = [
  'renders headings, emphasis, quotes, lists and line breaks with semantic elements',
  'escapes raw HTML, blocks executable links and never requests Markdown images',
  'allows only attribute-free ruby and keeps other HTML literal',
  'keeps fenced code, protected placeholders, template syntax and machine identifiers literal',
  'rejects unsafe and ambiguous URL schemes without accepting control-character obfuscation',
  'renders a long source without interpreting unsupported syntax as HTML',
  'reader defaults to Korean, preserves source identity and many-to-one translation anchors without commands',
];
const hasCase = (title, id) => new RegExp(`\\b${id}\\b`).test(title);

async function main() {
  if (process.argv.length > 2)
    throw new Error(`Unknown verify-ui option: ${process.argv.slice(2).join(' ')}`);
  const runId = `ui-${newId()}`;
  const directory = path.join(artifactRoot, runId);
  const runtime = path.join(directory, 'runtime');
  const children = new Set();
  const failures = [];
  let cancelled = false;
  let environmentBlocked = false;
  await mkdir(runtime, { recursive: true });
  const summary = {
    schema: 1,
    runId,
    status: 'FAIL',
    scope: 'Uimori UI automated checks only',
    startedAt: new Date().toISOString(),
    environment: { platform: process.platform, os: os.release(), node: process.version },
    commands: [],
    reports: {},
    coverage: {},
    failures,
    cleanup: { status: 'NOT_RUN' },
    limitations: [
      'A suite PASS covers only the assertions named in the fresh reporters; it is not full UI01-UI16 acceptance.',
      'UI14 performance measurements and UI16 human or reviewer-agent visual inspection must be supplied separately. Screenshot files alone do not establish visual quality.',
      'UI15 requires separate final-checkout M0 and M1-local evidence. This command does not replace those suites.',
      'Browser viewport and synthetic composition events do not establish physical-phone keyboard, IME, or background behavior.',
      'Synthetic local file SQLite and scripted/loopback fixtures only; no live provider, paid request, private prose, or remote deployment claim.',
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
  await json(path.join(directory, 'ownership.json'), owner);
  const cancel = (signal) => {
    cancelled = true;
    failures.push(`${signal}: UI verification cancelled`);
    for (const child of children)
      void killOwned(child).catch((error) =>
        failures.push(`Cancellation cleanup: ${error.message}`)
      );
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  async function run(args, name, env, timeout = 180000) {
    if (cancelled) throw new Error('Verification cancelled before command');
    const result = await command(args, {
      env,
      timeout,
      children,
      log: path.join(directory, `${name}.log`),
    });
    const { output, ...record } = result;
    summary.commands.push({ ...record, log: `${name}.log` });
    requireCommand(result);
  }
  async function tests(kind, args, env) {
    const since = Date.now();
    const reportFile = path.join(directory, `${kind}.json`);
    let commandError;
    try {
      await run(
        args(reportFile),
        kind,
        kind === 'playwright' ? { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile } : env,
        kind === 'playwright' ? 300000 : 120000
      );
    } catch (error) {
      commandError = error;
    }
    let reportError;
    try {
      summary.reports[kind] = await readReport(reportFile, since, kind);
    } catch (error) {
      summary.reports[kind] = error.observations || { status: 'FAIL', error: error.message };
      reportError = error;
    }
    if (commandError) failures.push(commandError.message);
    if (reportError) failures.push(reportError.message);
    if (commandError || reportError)
      throw new Error(`${kind} did not produce a passing fresh report`);
    return summary.reports[kind];
  }
  try {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major !== 24 || minor < 14) {
      environmentBlocked = true;
      throw new Error('UI verification needs repository-supported Node >=24.14.0 <25');
    }
    const executable = browserPath();
    if (!executable || !existsSync(executable)) {
      environmentBlocked = true;
      throw new Error(
        'Browser executable missing; configure NR_BROWSER_PATH for the local test browser'
      );
    }
    summary.environment.browser = executable;
    summary.identity = await assertBuild();
    // The fingerprint includes this runner and all test/config inputs.
    const initialFingerprint = await fingerprint();
    if (initialFingerprint.hash !== summary.identity.sourceHash)
      throw new Error('Source changed while checking the initial build identity');
    summary.expectedEvidence = {
      proseTitles: requiredProseTitles,
      requiredBrowserIds,
      browserFile: 'tests/ui-browser.spec.ts',
      skippedAllowed: 0,
      failuresAllowed: 0,
    };
    const temp = path.join(runtime, 'temp');
    await mkdir(temp, { recursive: true });
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
      TEMP: temp,
      TMP: temp,
    };
    if (cancelled) throw new Error('Verification cancelled before server start');
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
    const unit = await tests(
      'vitest',
      (report) => [
        'node_modules/vitest/vitest.mjs',
        'run',
        'tests/prose.test.ts',
        '--reporter=json',
        `--outputFile=${report}`,
      ],
      env
    );
    for (const title of requiredProseTitles)
      if (
        !unit.tests.some(
          (test) =>
            test.status === 'passed' && (test.title === title || test.title.endsWith(` ${title}`))
        )
      )
        throw new Error(`Missing required prose assertion: ${title}`);
    const browser = await tests(
      'playwright',
      () => [
        'node_modules/@playwright/test/cli.js',
        'test',
        'tests/ui-browser.spec.ts',
        '--reporter=json',
      ],
      env
    );
    for (const id of requiredBrowserIds)
      if (!browser.tests.some((test) => hasCase(test.title, id) && test.status === 'passed'))
        throw new Error(`${id}: zero required UI browser evidence`);
    // Do not infer complete scenario acceptance from a test-title tag.
    for (let index = 1; index <= 16; index++) {
      const id = `UI${String(index).padStart(2, '0')}`;
      const titles = browser.tests
        .filter((test) => hasCase(test.title, id))
        .map((test) => test.title);
      summary.coverage[id] = {
        automatedTestStatus: titles.length ? 'PASS' : 'NOT_RUN',
        evidence: titles,
        reporter: titles.length ? 'playwright.json' : null,
        acceptanceStatus:
          id === 'UI14'
            ? 'MEASUREMENT_REQUIRED'
            : id === 'UI16'
              ? 'VISUAL_REVIEW_REQUIRED'
              : id === 'UI15'
                ? 'SEPARATE_REGRESSION_REQUIRED'
                : titles.length
                  ? 'PARTIAL_AUTOMATED_EVIDENCE'
                  : 'NOT_ESTABLISHED',
      };
    }
    const finalIdentity = await assertBuild();
    if (
      finalIdentity.buildId !== summary.identity.buildId ||
      (await fingerprint()).hash !== initialFingerprint.hash
    )
      throw new Error('Source or compiled build changed during UI verification');
    summary.identityVerifiedAt = new Date().toISOString();
  } catch (error) {
    failures.push(error.message);
    if (summary.identity && !summary.identityVerifiedAt)
      summary.evidenceIdentity = 'NOT_CONFIRMED_AT_END';
  } finally {
    const cleanupErrors = [];
    const terminated = [];
    for (const child of children)
      try {
        terminated.push(await killOwned(child));
      } catch (error) {
        cleanupErrors.push(error.message);
      }
    const liveChildren = [...children].filter(
      (child) => child.pid && child.exitCode === null && child.signalCode === null
    );
    if (liveChildren.length)
      cleanupErrors.push(
        `Owned children still running; runtime retained: ${liveChildren.map((child) => child.pid).join(', ')}`
      );
    try {
      if (!liveChildren.length) {
        const evidence = path.join(directory, 'evidence-db');
        await mkdir(evidence, { recursive: true });
        for (const name of await readdir(runtime))
          if (/\.sqlite(?:-wal|-shm)?$/.test(name))
            await copyFile(path.join(runtime, name), path.join(evidence, name));
        // removeOwned verifies resolved containment and rejects symlinks/junctions.
        await removeOwned(directory, runtime);
      }
    } catch (error) {
      cleanupErrors.push(error.message);
    }
    summary.cleanup = {
      status: cleanupErrors.length ? 'FAIL' : 'PASS',
      terminated,
      livePids: liveChildren.map((child) => child.pid),
      removed: existsSync(runtime) ? [] : [runtime],
      retained: [
        'evidence-db',
        'fresh reporters',
        'command/server logs',
        'browser screenshots/traces',
      ],
      errors: cleanupErrors,
    };
    failures.push(...cleanupErrors.map((message) => `Cleanup: ${message}`));
    owner.active = liveChildren.length > 0;
    owner.finishedAt = new Date().toISOString();
    owner.cleanup = summary.cleanup;
    await json(path.join(directory, 'ownership.json'), owner);
    try {
      summary.artifactScan = await artifactScan(directory);
    } catch (error) {
      failures.push(error.message);
      summary.artifactScan = { status: 'FAIL', error: error.message };
    }
    summary.status = failures.length ? (environmentBlocked ? 'BLOCKED' : 'FAIL') : 'PASS';
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
          tests: Object.fromEntries(
            Object.entries(summary.reports).map(([kind, report]) => [
              kind,
              {
                discovered: report.discovered,
                passed: report.passed,
                skipped: report.skipped,
                failed: report.failed,
              },
            ])
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

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
