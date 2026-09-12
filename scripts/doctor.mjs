import browserWidths from '../fixtures/browser-viewports.json' with { type: 'json' };
const { mobile: MOBILE_WIDTH } = browserWidths;
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { artifactRoot, newId, browserPath, json, removeOwned } from './lib.mjs';

export function supportedNode(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return Boolean(match && Number(match[1]) === 24 && Number(match[2]) >= 14);
}

export function doctorStatus(checks) {
  if (
    !checks.length ||
    checks.some((check) => !['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].includes(check.status))
  )
    return 'FAIL';
  if (checks.some((check) => check.status === 'FAIL')) return 'FAIL';
  if (checks.some((check) => check.status === 'BLOCKED')) return 'BLOCKED';
  if (checks.some((check) => check.status === 'NOT_RUN' && check.required)) return 'BLOCKED';
  return 'PASS';
}

function diagnostic(error) {
  const message = String(error?.message ?? error)
    .split('\n')[0]
    .slice(0, 600);
  const code = error?.code ?? /\b(EACCES|EPERM|ENOENT)\b/.exec(message)?.[1];
  const blocked =
    ['EACCES', 'EPERM', 'ENOENT', 'ERR_MODULE_NOT_FOUND', 'ERR_UNKNOWN_BUILTIN_MODULE'].includes(
      code
    ) ||
    /Executable doesn't exist|Browser executable missing|requires Node|unable to open database file/.test(
      message
    );
  return {
    status: blocked ? 'BLOCKED' : 'FAIL',
    error: message,
    ...(code ? { code } : {}),
    ...(error?.childCleanupFailed ? { childCleanupFailed: true } : {}),
    ...(code === 'EPERM' || code === 'EACCES'
      ? {
          prerequisite:
            'This host must allow the reported local operation. No permission changes or retries were attempted.',
        }
      : {}),
  };
}

export async function probeNodeChild({ spawnChild = spawn, timeoutMs = 5000 } = {}) {
  const marker = 'uimori-doctor-child-ready';
  const child = spawnChild(process.execPath, ['-e', `process.stdout.write('${marker}')`], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let timedOut = false;
  let timer;
  let cleanupTimer;
  try {
    return await new Promise((resolve, reject) => {
      child.stdout.on('data', (value) => {
        output = (output + value).slice(0, 1000);
      });
      // Drain stderr without collecting inherited environment or unrelated diagnostics.
      child.stderr.resume();
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (timedOut) reject(new Error(`Node child ready probe timed out (${timeoutMs}ms)`));
        else if (code !== 0)
          reject(new Error(`Node child exited before ready (code=${code}, signal=${signal})`));
        else if (output !== marker) reject(new Error('Node child ready marker missing'));
        else resolve({ exitCode: code, readyMarker: true, childClosed: true });
      });
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          // A bounded fallback below reports failure to close the owned child.
        }
        cleanupTimer = setTimeout(
          () =>
            reject(
              Object.assign(new Error('Owned Node probe did not close after timeout'), {
                childCleanupFailed: true,
              })
            ),
          1000
        );
      }, timeoutMs);
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(cleanupTimer);
  }
}

export async function doctor(
  directory = path.join(artifactRoot, `doctor-${newId()}`),
  { browser: checkBrowser = true, nodeVersion = process.versions.node, spawnChild = spawn } = {}
) {
  directory = path.resolve(directory);
  const temp = path.join(directory, 'doctor-temp');
  const result = {
    status: 'FAIL',
    scope: checkBrowser ? 'browser-environment' : 'api-environment',
    report: path.join(directory, 'doctor.json'),
    startedAt: new Date().toISOString(),
    platform: process.platform,
    os: os.release(),
    node: nodeVersion,
    requiredNode: '>=24.14.0 <25.0.0',
    shell: process.env.PSModulePath ? 'PowerShell host environment' : 'direct Node child processes',
    checks: [],
  };
  let db;
  let server;
  let context;
  let url;
  async function check(name, run) {
    const started = Date.now();
    try {
      result.checks.push({
        name,
        required: true,
        status: 'PASS',
        ...(await run()),
        elapsedMs: Date.now() - started,
      });
    } catch (error) {
      result.checks.push({
        name,
        required: true,
        ...diagnostic(error),
        elapsedMs: Date.now() - started,
      });
    }
  }
  try {
    await check('supported-node-runtime', async () => {
      if (!supportedNode(nodeVersion))
        throw new Error('This checkout requires Node >=24.14.0 <25.0.0.');
    });
    await check('node-child-ready-exit', () => probeNodeChild({ spawnChild }));
    await check('writable-directory', async () => {
      await mkdir(temp, { recursive: true });
      await writeFile(path.join(temp, 'write-probe.txt'), 'synthetic write probe');
      return { path: temp };
    });
    await check('file-sqlite-transaction-reopen', async () => {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(path.join(temp, 'doctor.sqlite'));
      db.exec('CREATE TABLE probe(value INTEGER); BEGIN; INSERT INTO probe VALUES(7); ROLLBACK;');
      if (db.prepare('SELECT COUNT(*) AS count FROM probe').get().count !== 0)
        throw new Error('SQLite rollback failed');
      db.exec('BEGIN; INSERT INTO probe VALUES(9); COMMIT;');
      db.close();
      db = new DatabaseSync(path.join(temp, 'doctor.sqlite'));
      if (db.prepare('SELECT value FROM probe').get().value !== 9)
        throw new Error('SQLite file reopen failed');
      result.sqlite = db.prepare('SELECT sqlite_version() AS version').get().version;
      db.close();
      db = undefined;
    });
    await check('localhost-bind-http', async () => {
      server = http.createServer((_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><html><body><h1>로컬 실행 확인</h1></body></html>');
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      url = `http://127.0.0.1:${server.address().port}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok || !(await response.text()).includes('로컬 실행 확인'))
        throw new Error('localhost HTTP probe mismatch');
      return { url };
    });
    if (!checkBrowser || !url) {
      result.checks.push({
        name: 'browser-launch-and-local-page',
        required: checkBrowser,
        status: 'NOT_RUN',
        reason: checkBrowser
          ? 'Local HTTP server was unavailable'
          : 'Explicit --no-browser; API environment only',
      });
    } else {
      await check('browser-launch-and-local-page', async () => {
        const { chromium } = await import('@playwright/test');
        const executablePath = browserPath();
        if (executablePath && !existsSync(executablePath))
          throw new Error('Browser executable missing');
        context = await chromium.launchPersistentContext(path.join(temp, 'browser-profile'), {
          executablePath,
          headless: true,
          // Same as playwright.config.ts: a system PAC proxy must not intercept 127.0.0.1.
          args: ['--no-proxy-server'],
          viewport: { width: MOBILE_WIDTH, height: 844 },
          timeout: 10000,
        });
        const page = await context.newPage();
        await page.goto(url, { timeout: 10000 });
        if ((await page.locator('h1').innerText()) !== '로컬 실행 확인')
          throw new Error('Browser localhost page mismatch');
        result.browser = {
          name: 'chromium',
          version: context.browser().version(),
          executablePath: executablePath || 'Playwright managed browser',
          viewport: `${MOBILE_WIDTH}x844 emulator`,
        };
        await page.screenshot({ path: path.join(directory, 'doctor-browser.png') });
        await context.close();
        context = undefined;
      });
    }
  } finally {
    const failures = result.checks
      .filter((check) => check.childCleanupFailed)
      .map((check) => ({ name: check.name, status: 'FAIL', error: check.error }));
    for (const [name, close] of [
      ['sqlite', () => db?.close()],
      ['browser', () => context?.close()],
      [
        'http',
        () =>
          server?.listening &&
          new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          ),
      ],
      ['temporary-files', () => existsSync(temp) && removeOwned(directory, temp)],
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push({ name, ...diagnostic(error) });
      }
    }
    result.cleanup = failures.length
      ? { status: 'FAIL', failures }
      : { status: 'PASS', removed: [temp], ownedLocalServerClosed: true, browserClosed: true };
    result.status = doctorStatus([...result.checks, result.cleanup]);
    if (result.status !== 'PASS') {
      result.error = [...result.checks, ...failures]
        .filter(
          (check) =>
            check.status === 'FAIL' ||
            check.status === 'BLOCKED' ||
            (check.required && check.status === 'NOT_RUN')
        )
        .map((check) => `${check.name}: ${check.error || check.reason}`)
        .join('; ');
    }
    result.finishedAt = new Date().toISOString();
    await json(result.report, result);
  }
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = process.argv.slice(2);
  if (options.some((option) => option !== '--no-browser')) {
    console.error('Usage: node scripts/doctor.mjs [--no-browser]');
    process.exitCode = 1;
  } else {
    const result = await doctor(undefined, { browser: !options.includes('--no-browser') });
    console.log(JSON.stringify(result, null, 2));
    console.log(`Doctor ${result.status} (${result.scope}). Report: ${result.report}`);
    if (result.status !== 'PASS') process.exitCode = 1;
  }
}
