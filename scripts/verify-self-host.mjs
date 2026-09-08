import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { chromium } from '@playwright/test';
import {
  root,
  createOwnership,
  artifactRoot,
  newId,
  json,
  assertBuild,
  fingerprint,
  browserPath,
  command,
  readReport,
  requireCommand,
  killOwned,
  removeOwned,
  artifactScan,
  canary,
} from './lib.mjs';

if (process.argv.length > 2) throw new Error('verify-self-host accepts no arguments');
const runId = `self-host-${newId()}`,
  directory = path.join(artifactRoot, runId),
  runtime = path.join(directory, 'runtime');
await mkdir(runtime, { recursive: true });
const children = new Set(),
  failures = [];
const summary = {
  runId,
  status: 'FAIL',
  startedAt: new Date().toISOString(),
  scope:
    'Personal self-host over an actual loopback HTTPS reverse proxy and independent desktop/mobile Chromium contexts',
  failures,
  limitations: [
    'Self-signed, publicly committed test certificate; Chromium explicitly ignores certificate verification errors. Public TLS issuance and DNS are not tested.',
    'Runs on the current host OS with Node and a Node HTTPS proxy. This is not Linux, Docker or production proxy execution evidence.',
    '390px Chromium viewport/touch emulation is not physical mobile Safari/Chrome, OS keyboard, background suspension or network handoff evidence.',
    'Fresh isolated SQLite, synthetic token, bot and mock generation only. No personal data, live provider, billing or external deployment.',
    'Browser re-entry verifies stored results and independent sessions; mock generation is immediate and does not establish a long-running live-provider disconnect result.',
  ],
};
const ownership = createOwnership(directory, summary.startedAt);
await json(path.join(directory, 'ownership.json'), ownership);
let environmentBlocked = false,
  proxy;
const cancel = (signal) => {
  failures.push(`${signal}: self-host smoke cancelled`);
  for (const child of children)
    void killOwned(child).catch((error) => failures.push(error.message));
};
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);

// Keep production Host/Origin exactly as received; forwarding metadata carries
// no authority. Streams are piped and headers flushed without body buffering.
async function startProxy() {
  const tlsDirectory = path.join(root, 'tests', 'fixtures', 'self-host');
  const sockets = new Set(),
    upstreamRequests = new Set();
  const stats = { requests: 0, eventStreams: 0, eventBytes: 0, upstreamErrors: 0 };
  let target;
  const server = createHttpsServer(
    {
      key: await readFile(path.join(tlsDirectory, 'test-only-key.pem')),
      cert: await readFile(path.join(tlsDirectory, 'test-only-cert.pem')),
    },
    (request, response) => {
      stats.requests++;
      if (!target) {
        response.writeHead(503).end();
        return;
      }
      const upstream = httpRequest(
        new URL(request.url ?? '/', target),
        { method: request.method, headers: { ...request.headers, connection: 'close' } },
        (incoming) => {
          response.writeHead(incoming.statusCode ?? 502, incoming.headers);
          response.flushHeaders();
          if (String(incoming.headers['content-type']).startsWith('text/event-stream')) {
            stats.eventStreams++;
            incoming.on('data', (data) => {
              stats.eventBytes += data.length;
            });
          }
          incoming.on('error', () => response.destroy());
          incoming.pipe(response);
        }
      );
      upstreamRequests.add(upstream);
      upstream.once('close', () => upstreamRequests.delete(upstream));
      upstream.on('error', () => {
        if (response.destroyed) return;
        stats.upstreamErrors++;
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.on('aborted', () => upstream.destroy());
      response.on('close', () => upstream.destroy());
      request.pipe(upstream);
    }
  );
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('HTTPS proxy did not bind an isolated port');
  return {
    origin: `https://127.0.0.1:${address.port}`,
    setTarget: (value) => {
      target = value;
    },
    stats: () => ({ ...stats }),
    close: async () => {
      for (const request of upstreamRequests) request.destroy();
      const closed = new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

function secureRequest(origin, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const request = httpsRequest(
      new URL(pathname, origin),
      {
        method,
        rejectUnauthorized: false,
        headers: {
          ...headers,
          ...(encoded === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) }),
        },
      },
      (response) => {
        const parts = [];
        response.on('data', (part) => parts.push(part));
        response.once('error', reject);
        response.once('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(parts).toString('utf8'),
          })
        );
      }
    );
    request.setTimeout(5000, () => request.destroy(new Error('HTTPS identity request timeout')));
    request.once('error', reject);
    request.end(encoded);
  });
}

async function startApp(env) {
  const child = spawn(process.execPath, ['dist/server/index.js'], {
    cwd: root,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '',
    pending = '';
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('App ready timeout (15000ms)')), 15000);
      const fail = (value) => {
        clearTimeout(timer);
        reject(new Error(`App exited before ready (${value}): ${output.slice(-1000)}`));
      };
      child.once('error', fail);
      child.once('exit', fail);
      child.stderr.on('data', (value) => {
        output += value;
      });
      child.stdout.on('data', (value) => {
        output += value;
        pending += value;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const line of lines) {
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.event === 'ready') {
            clearTimeout(timer);
            child.removeListener('exit', fail);
            child.removeListener('error', fail);
            resolve(event);
          }
        }
      });
    });
    if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(ready.url))
      throw new Error('Unexpected internal ready URL');
    return { child, ready, log: () => writeFile(path.join(directory, 'server.log'), output) };
  } catch (error) {
    await writeFile(path.join(directory, 'server.log'), output);
    throw error;
  }
}

let server;
try {
  const browser = browserPath() ?? chromium.executablePath();
  if (!browser || !existsSync(browser)) {
    environmentBlocked = true;
    throw new Error('Local test browser unavailable');
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 14) {
    environmentBlocked = true;
    throw new Error('Node >=24.14.0 <25 required');
  }
  const identity = await assertBuild(),
    before = await fingerprint();
  summary.identity = identity;
  const temp = path.join(runtime, 'temp');
  await mkdir(temp, { recursive: true });
  proxy = await startProxy();
  const env = {
    NR_DB: path.join(runtime, 'self-host.sqlite'),
    NR_PORT: '0',
    NR_HOST: '127.0.0.1',
    NR_INSTANCE: runId,
    NR_BUILD_ID: identity.buildId,
    NR_TEST_MODE: '',
    NR_PUBLIC_ORIGIN: proxy.origin,
    NR_ACCESS_TOKEN: randomBytes(32).toString('hex'),
    NR_PROVIDER_ORIGINS: '',
    NR_ARTIFACT_DIR: directory,
    NR_BROWSER_OUTPUT: path.join(directory, 'browser'),
    NR_SECRET_CANARY: canary,
    NR_BROWSER_PATH: browser,
    NR_SELF_HOST_BROWSER: '1',
    NR_BASE_URL: proxy.origin,
    TEMP: temp,
    TMP: temp,
  };
  server = await startApp(env);
  proxy.setTarget(server.ready.url);
  summary.server = server.ready;
  summary.publicOrigin = proxy.origin;
  ownership.children.push({ pid: server.child.pid, dbPath: env.NR_DB, url: server.ready.url });
  await json(path.join(directory, 'ownership.json'), ownership);
  const login = await secureRequest(proxy.origin, '/api/session', {
    method: 'POST',
    headers: { Origin: proxy.origin },
    body: { token: env.NR_ACCESS_TOKEN },
  });
  const cookie = login.headers['set-cookie']?.[0]?.split(';')[0];
  if (login.status !== 200 || !cookie) throw new Error('HTTPS preflight session creation failed');
  const health = await secureRequest(proxy.origin, '/api/health', { headers: { Cookie: cookie } });
  if (health.status !== 200) throw new Error(`HTTPS health HTTP ${health.status}`);
  const actual = JSON.parse(health.body);
  for (const [key, expected] of Object.entries({
    buildId: env.NR_BUILD_ID,
    instanceId: env.NR_INSTANCE,
    dbPath: env.NR_DB,
  }))
    if (actual[key] !== expected) throw new Error(`HTTPS health identity mismatch: ${key}`);
  const logout = await secureRequest(proxy.origin, '/api/session', {
    method: 'DELETE',
    headers: { Origin: proxy.origin, Cookie: cookie },
    body: {},
  });
  if (logout.status !== 200) throw new Error('HTTPS preflight session cleanup failed');
  const reporter = path.join(directory, 'playwright.json'),
    since = Date.now();
  const result = await command(
    [
      'node_modules/@playwright/test/cli.js',
      'test',
      'tests/self-host-browser.spec.ts',
      '--reporter=json',
    ],
    {
      env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: reporter },
      timeout: 180_000,
      log: path.join(directory, 'playwright.log'),
      children,
    }
  );
  const { output: _output, ...record } = result;
  summary.command = record;
  try {
    summary.report = await readReport(reporter, since, 'playwright');
  } catch (error) {
    summary.report = error.observations;
    throw error;
  }
  requireCommand(result);
  for (const id of ['SHUI01', 'SHUI02'])
    if (!summary.report.tests.some((test) => test.status === 'passed' && test.title.includes(id)))
      throw new Error(`Missing ${id} evidence`);
  if (!proxy.stats().eventStreams || !proxy.stats().eventBytes)
    throw new Error('No actual HTTPS event stream bytes observed');
  if (
    (await assertBuild()).buildId !== identity.buildId ||
    (await fingerprint()).hash !== before.hash
  )
    throw new Error('Build/source identity changed during self-host verification');
  summary.identityVerifiedAt = new Date().toISOString();
} catch (error) {
  failures.push(error.message);
  if (/spawn EPERM|Browser executable missing/u.test(error.message)) environmentBlocked = true;
} finally {
  const cleanupErrors = [];
  if (proxy)
    try {
      summary.proxy = proxy.stats();
      await proxy.close();
    } catch (error) {
      cleanupErrors.push(error.message);
    }
  for (const child of children)
    try {
      await killOwned(child);
    } catch (error) {
      cleanupErrors.push(error.message);
    }
  if (server)
    try {
      await server.log();
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
      for (const name of await readdir(runtime))
        if (/\.sqlite(?:-wal|-shm)?$/u.test(name))
          await copyFile(path.join(runtime, name), path.join(evidence, name));
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
  failures.push(...cleanupErrors);
  ownership.active = live.length > 0;
  ownership.finishedAt = new Date().toISOString();
  ownership.cleanup = summary.cleanup;
  await json(path.join(directory, 'ownership.json'), ownership);
  try {
    summary.artifactScan = await artifactScan(directory);
  } catch (error) {
    failures.push(error.message);
  }
  summary.status = failures.length ? (environmentBlocked ? 'BLOCKED' : 'FAIL') : 'PASS';
  summary.finishedAt = new Date().toISOString();
  await json(path.join(directory, 'summary.json'), summary);
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
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
