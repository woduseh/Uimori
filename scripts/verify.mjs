import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, copyFile } from 'node:fs/promises';
import { doctor } from './doctor.mjs';
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

const foundationCases = ['F01', 'F02', 'F03', 'F04', 'F05', 'F06'];
const productCases = Array.from({ length: 13 }, (_, i) => `P${String(i + 1).padStart(2, '0')}`);
const storyCases = Array.from({ length: 7 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`);
function options(args) {
  let milestone = 'M0';
  const cases = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--milestone') milestone = args[++index];
    else if (args[index] === '--case') cases.push(...(args[++index] || '').split(','));
    else throw new Error(`Unknown verify option: ${args[index]}`);
  }
  if (!['M0', 'M1-local', 'M1', 'M2-local', 'M2'].includes(milestone))
    throw new Error(`Unknown/unimplemented milestone: ${milestone}`);
  const allCases =
    milestone === 'M0' ? foundationCases : milestone.startsWith('M2') ? storyCases : productCases;
  if (cases.some((id) => !allCases.includes(id)))
    throw new Error(`Unknown case: ${cases.join(',')}`);
  return { milestone, cases: cases.length ? [...new Set(cases)] : allCases };
}

async function main(selection) {
  const runId = newId();
  const directory = path.join(artifactRoot, runId);
  const runtime = path.join(directory, 'runtime');
  await mkdir(runtime, { recursive: true });
  const children = new Set();
  const failures = [];
  const product = selection.milestone !== 'M0';
  const requiredBrowser = product
    ? ['P01', 'P04', 'P06', 'P09', 'P10', 'P11', 'P13']
    : ['F02', 'F03', 'F05'];
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
    limitations: [
      product
        ? 'M1 local file SQLite, browser and fixture HTTP only. Live provider/protocol, semantic quality and physical-phone/private-deployment claims remain BLOCKED.'
        : 'Scripted mock only; no paid/live provider, quality, physical phone, public deployment, or M1+ claim.',
    ],
    ...(product
      ? {
          externalClaims: {
            L01: {
              status: 'BLOCKED',
              reason:
                'This local verifier does not execute or import live evidence; see the separate output/live artifacts and M1-RESULTS',
            },
            L02: {
              status: 'BLOCKED',
              reason: 'Private deployment target and physical phone pending',
            },
            Q01: {
              status: 'BLOCKED',
              reason: 'Human creative-quality evaluation is not performed by this local verifier',
            },
            Q02: {
              status: 'BLOCKED',
              reason: 'Human refusal-quality evaluation is not performed by this local verifier',
            },
            Q03: {
              status: 'BLOCKED',
              reason:
                'Human translation-quality evaluation is not performed by this local verifier',
            },
            Q05: {
              status: 'BLOCKED',
              reason: 'Live image selection and approved quality sample pending',
            },
          },
        }
      : {}),
    failures,
    cleanup: { status: 'NOT_RUN' },
  };
  let server;
  let browserBlocked = false;
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
    failures.push(`${signal}: verification cancelled`);
    for (const child of children)
      void killOwned(child).catch((error) =>
        failures.push(`Cancellation cleanup: ${error.message}`)
      );
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  async function run(args, name, env = {}, timeout = 120000) {
    const result = await command(args, {
      env,
      timeout,
      children,
      log: path.join(directory, `${name}.log`),
    });
    const { output, ...record } = result;
    summary.commands.push({ ...record, log: `${name}.log` });
    requireCommand(result);
    return result;
  }
  try {
    // Diagnose possible orphans without killing PIDs from old manifests (PID reuse is unsafe).
    summary.orphans = [];
    for (const name of await readdir(artifactRoot)) {
      const file = path.join(artifactRoot, name, 'ownership.json');
      if (name === runId || !existsSync(file)) continue;
      const old = JSON.parse(await readFile(file, 'utf8'));
      if (old.active)
        summary.orphans.push({
          runId: old.runId,
          ownerPid: old.ownerPid,
          action: 'inspect-only; never kill an unverified old PID',
        });
    }
    if (
      selection.cases.includes('F01') ||
      selection.cases.some((id) => requiredBrowser.includes(id))
    ) {
      const result = await doctor(directory);
      summary.environment.doctor = result;
      if (result.status !== 'PASS') {
        browserBlocked =
          result.checks.some((check) => check.name === 'file-sqlite-transaction-reopen') &&
          result.checks.some((check) => check.name === 'localhost-bind-http') &&
          result.cleanup?.status === 'PASS';
        if (!browserBlocked) {
          for (const id of selection.cases) summary.scenarios[id].status = 'BLOCKED';
          throw new Error(
            `Environment doctor ${result.status}: ${result.error || result.cleanup?.error}`
          );
        }
        failures.push(`Browser claims BLOCKED: ${result.error}`);
        for (const id of selection.cases.filter((id) => ['F01', ...requiredBrowser].includes(id)))
          summary.scenarios[id] = {
            required: true,
            status: 'BLOCKED',
            evidence: ['doctor.json'],
            error: result.error,
          };
      }
      if (summary.scenarios.F01 && !browserBlocked)
        summary.scenarios.F01 = {
          required: true,
          status: 'PASS',
          evidence: ['doctor.json', 'doctor-browser.png', 'ownership.json', 'summary.json#cleanup'],
          note: 'Checkout/worktree cross-check evidence is recorded separately when run by the release operator.',
        };
    }
    await run(['node_modules/typescript/bin/tsc', '--noEmit'], 'check');
    await run(['scripts/build.mjs'], 'build');
    const manifest = await assertBuild();
    summary.identity = manifest;
    const temp = path.join(runtime, 'temp');
    await mkdir(temp, { recursive: true });
    const env = {
      NR_DB: path.join(runtime, 'app.sqlite'),
      NR_PORT: '0',
      NR_INSTANCE: runId,
      NR_BUILD_ID: manifest.buildId,
      NR_TEST_MODE: '1',
      NR_ACCESS_TOKEN: '',
      NR_PROVIDER_ORIGINS: '',
      NR_ARTIFACT_DIR: directory,
      NR_BROWSER_OUTPUT: path.join(directory, 'browser'),
      NR_SECRET_CANARY: canary,
      TEMP: temp,
      TMP: temp,
      ...(browserPath() ? { NR_BROWSER_PATH: browserPath() } : {}),
    };
    server = await startServer(env, directory, children);
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
    const software = selection.cases.filter((id) =>
      (product ? productCases : ['F02', 'F03', 'F04', 'F05']).includes(id)
    );
    const unitCases = selection.cases;
    if (unitCases.length) {
      const since = Date.now();
      const reportFile = path.join(directory, 'vitest.json');
      let executionError;
      const failureCount = failures.length;
      try {
        await run(
          [
            'node_modules/vitest/vitest.mjs',
            'run',
            '--reporter=json',
            `--outputFile=${reportFile}`,
            '-t',
            unitCases.join('|'),
          ],
          'vitest',
          env
        );
      } catch (error) {
        executionError = error;
      }
      try {
        summary.reports.vitest = await readReport(
          reportFile,
          since,
          'vitest',
          new RegExp(`\\b(${unitCases.join('|')})\\b`)
        );
      } catch (error) {
        summary.reports.vitest = error.observations || { status: 'FAIL', error: error.message };
        failures.push(error.message);
      }
      if (executionError) throw executionError;
      if (failures.length > failureCount) throw new Error('Required Vitest evidence is not PASS');
      if (summary.scenarios.F01)
        summary.scenarios.F01.serverEvidence = summary.reports.vitest.tests
          .filter((test) => /\bF01\b/.test(test.title))
          .map((test) => test.title);
    }
    const browserCases = software.filter((id) => requiredBrowser.includes(id));
    if (browserCases.length && !browserBlocked) {
      const since = Date.now();
      const reportFile = path.join(directory, 'playwright.json');
      let executionError;
      const failureCount = failures.length;
      try {
        await run(
          [
            'node_modules/@playwright/test/cli.js',
            'test',
            '--reporter=json',
            '--grep',
            browserCases.join('|'),
          ],
          'playwright',
          { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile },
          120000
        );
      } catch (error) {
        executionError = error;
      }
      try {
        summary.reports.playwright = await readReport(reportFile, since, 'playwright');
      } catch (error) {
        summary.reports.playwright = error.observations || { status: 'FAIL', error: error.message };
        failures.push(error.message);
      }
      if (executionError) throw executionError;
      if (failures.length > failureCount) throw new Error('Required browser evidence is not PASS');
    }
    for (const id of software) {
      const unitEvidence =
        summary.reports.vitest?.tests.filter((test) =>
          new RegExp(`\\b${id}\\b`).test(test.title)
        ) || [];
      const browserEvidence =
        summary.reports.playwright?.tests.filter((test) =>
          new RegExp(`\\b${id}\\b`).test(test.title)
        ) || [];
      if (browserBlocked && browserCases.includes(id)) {
        summary.scenarios[id].serverEvidence = unitEvidence.map((test) => test.title);
        continue;
      }
      if (!unitEvidence.length || (browserCases.includes(id) && !browserEvidence.length))
        throw new Error(
          `${id}: zero required evidence in ${!unitEvidence.length ? 'Vitest' : 'Playwright'} reporter`
        );
      summary.scenarios[id] = {
        required: true,
        status: 'PASS',
        evidence: [...unitEvidence, ...browserEvidence].map((test) => test.title),
        reporters: ['vitest.json', ...(browserCases.includes(id) ? ['playwright.json'] : [])],
      };
    }
    if (selection.cases.includes('F06')) {
      const selfDir = path.join(directory, 'selftest');
      await run(['scripts/selftest.mjs', '--output', selfDir], 'selftest', {}, 120000);
      summary.selftest = JSON.parse(await readFile(path.join(selfDir, 'selftest.json'), 'utf8'));
      if (summary.selftest.status !== 'PASS')
        throw new Error('Failure-detector selftest is not PASS');
      summary.scenarios.F06 = {
        required: true,
        status: 'PASS',
        evidence: ['selftest/selftest.json', 'summary.json#identity', 'summary.json#artifactScan'],
        serverEvidence: summary.reports.vitest.tests
          .filter((test) => /\bF06\b/.test(test.title))
          .map((test) => test.title),
        note: 'Selftest PASS means intentional inner failures were detected, not product assertions passed.',
      };
    }
    try {
      await assertBuild();
      if ((await fingerprint()).hash !== summary.identity.sourceHash)
        throw new Error('Source changed during verification');
    } catch (error) {
      for (const scenario of Object.values(summary.scenarios)) {
        scenario.evidenceInvalid = true;
        scenario.identityError = error.message;
      }
      throw error;
    }
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
    const liveChildren = [...children].filter(
      (child) => child.pid && child.exitCode === null && child.signalCode === null
    );
    if (liveChildren.length)
      cleanupErrors.push(
        `Owned children still running; DB/runtime retained: ${liveChildren.map((child) => child.pid).join(', ')}`
      );
    try {
      if (!liveChildren.length) {
        const dbEvidence = path.join(directory, 'evidence-db');
        await mkdir(dbEvidence, { recursive: true });
        for (const name of await readdir(runtime))
          if (/\.sqlite(?:-wal|-shm)?$/.test(name))
            await copyFile(path.join(runtime, name), path.join(dbEvidence, name));
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
        ...(liveChildren.length ? ['live runtime; no DB copy attempted'] : ['evidence-db']),
        'test reports',
        'logs',
        'browser evidence',
      ],
      errors: cleanupErrors,
    };
    failures.push(...cleanupErrors.map((error) => `Cleanup: ${error}`));
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
    if (failures.length)
      for (const scenario of Object.values(summary.scenarios))
        if (scenario.status === 'NOT_RUN') scenario.status = 'FAIL';
    summary.status = failures.length
      ? Object.values(summary.scenarios).some((item) => item.status === 'BLOCKED')
        ? 'BLOCKED'
        : 'FAIL'
      : Object.values(summary.scenarios).every((item) => item.status === 'PASS')
        ? 'PASS'
        : 'FAIL';
    if (product) summary.localStatus = summary.status;
    if (selection.milestone === 'M1' && summary.status === 'PASS') summary.status = 'BLOCKED';
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
            Object.entries(summary.scenarios).map(([id, item]) => [id, item.status])
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
  const selection = options(process.argv.slice(2));
  if (selection.milestone.startsWith('M2'))
    await (await import('./verify-story.mjs')).verifyStory(selection);
  else await main(selection);
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
