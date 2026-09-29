import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { readAccessEnv, runOracleSmoke } from './oracle-smoke.mjs';

const origin = 'https://uimori.example.test:8443';
const token = 'a'.repeat(64);
const buildId = 'b'.repeat(64);
const session = 'c'.repeat(64);

function fixtureRequest(options = {}) {
  const calls = [];
  const request = async ({ url, method, headers, body }) => {
    const pathname = `${url.pathname}${url.search}`;
    calls.push({ pathname, method, headers: { ...headers }, body });
    if (options.throwAt === pathname && headers.Cookie === `uimori_session=${session}`)
      throw new Error(`transport ${token} ${session}`);
    if (options.redirectAt === pathname)
      return { status: 302, headers: { location: `${origin}/redirected` }, body: '' };
    if (pathname === '/' && method === 'GET')
      return {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<!doctype html><div id="root"></div><script type="module" src="/assets/main.js"></script>',
      };
    if (pathname === '/assets/main.js' && method === 'GET')
      return {
        status: 200,
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
        body: `console.log('fixture');${'x'.repeat(100)}`,
      };
    const authenticated = headers.Cookie === `uimori_session=${session}`;
    if (pathname === '/api/session' && method === 'POST') {
      assert.equal(headers.Origin, origin);
      assert.equal(JSON.parse(body).token, token);
      return {
        status: 200,
        headers: {
          'set-cookie': `uimori_session=${session}; ${options.cookieAttributes ?? 'Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=43200'}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ required: true, authenticated: true }),
      };
    }
    if (!authenticated) return { status: options.anonymousStatus ?? 401, headers: {}, body: '{}' };
    if (pathname === '/api/session' && method === 'DELETE') {
      assert.equal(headers.Origin, origin);
      return { status: 200, headers: {}, body: JSON.stringify({ authenticated: false }) };
    }
    if (pathname === '/api/health')
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ready: true,
          testMode: false,
          mode: 'self-host',
          buildId: options.badBuild ? 'd'.repeat(64) : buildId,
        }),
      };
    if (pathname === '/api/library?view=summary')
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contentBodiesOmitted: true,
          assetsOmitted: true,
          organization: { revision: 1, folders: [], items: [] },
          contents: [],
          connections: [],
          models: [],
          promptPresets: [],
          promptCombinations: [],
          assets: [],
        }),
      };
    if (pathname === '/api/prompt-workspace')
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          revision: 1,
          main: { program: { version: 1 } },
          translation: { program: { version: 1 } },
          translationPolicy: { maxRetries: 1 },
        }),
      };
    throw new Error(`unexpected fixture request: ${method} ${pathname}`);
  };
  return { calls, request };
}

test('trusted smoke reads the app and logs out only its own temporary session', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uimori-oracle-output-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputFile = path.join(directory, 'nested', 'summary.json');
  const fixture = fixtureRequest();
  const summary = await runOracleSmoke({
    origin,
    token,
    buildId,
    outputFile,
    request: fixture.request,
  });
  assert.equal(summary.status, 'PASS');
  assert.equal(summary.proof, 'HTTPS/API');
  assert.deepEqual(summary.requestCounts, { GET: 8, POST: 1, DELETE: 1 });
  assert.equal(summary.sessionCleanup.status, 'PASS');
  assert.equal(fixture.calls.filter((call) => call.method === 'POST').length, 1);
  assert.deepEqual(
    fixture.calls.filter((call) => call.method === 'POST').map((call) => call.pathname),
    ['/api/session']
  );
  assert.deepEqual(
    fixture.calls.filter((call) => call.method === 'DELETE'),
    [
      {
        pathname: '/api/session',
        method: 'DELETE',
        headers: { Origin: origin, Cookie: `uimori_session=${session}` },
        body: undefined,
      },
    ]
  );
  assert.ok(fixture.calls.every((call) => ['GET', 'POST', 'DELETE'].includes(call.method)));
  assert.ok(fixture.calls.every((call) => !/export|backup|import|model|run/u.test(call.pathname)));
  assert.equal(JSON.stringify(summary).includes(token), false);
  assert.equal(JSON.stringify(summary).includes(session), false);
  assert.deepEqual(JSON.parse(await readFile(outputFile, 'utf8')), summary);
});

test('smoke rejects non-HTTPS and non-origin inputs before issuing a request', async () => {
  for (const invalid of [
    'http://uimori.example.test',
    'https://uimori.example.test/path',
    'https://user:pass@uimori.example.test',
    'https://uimori.example.test?query=1',
  ]) {
    let calls = 0;
    const summary = await runOracleSmoke({
      origin: invalid,
      token,
      buildId,
      request: async () => {
        calls++;
      },
    });
    assert.equal(summary.status, 'FAIL');
    assert.equal(summary.origin, null);
    assert.equal(calls, 0);
  }
});

test('anonymous access must be denied before the single allowed POST', async () => {
  const fixture = fixtureRequest({ anonymousStatus: 200 });
  const summary = await runOracleSmoke({ origin, token, buildId, request: fixture.request });
  assert.equal(summary.status, 'FAIL');
  assert.equal(summary.checks[0].name, 'anonymous APIs deny access');
  assert.equal(summary.checks[0].status, 'FAIL');
  assert.equal(summary.requestCounts.POST, 0);
});

test('authentication redirects are refused and never followed', async () => {
  const fixture = fixtureRequest({ redirectAt: '/api/session' });
  const summary = await runOracleSmoke({ origin, token, buildId, request: fixture.request });
  assert.equal(summary.status, 'FAIL');
  assert.equal(summary.requestCounts.POST, 1);
  assert.match(summary.failures[0], /redirect refused \(HTTP 302\)/u);
  assert.equal(
    fixture.calls.some((call) => call.pathname === '/redirected'),
    false
  );
});

test('session acceptance requires every deployed cookie security attribute', async () => {
  const fixture = fixtureRequest({
    cookieAttributes: 'Path=/; HttpOnly; SameSite=Strict; Max-Age=43200',
  });
  const summary = await runOracleSmoke({ origin, token, buildId, request: fixture.request });
  assert.equal(summary.status, 'FAIL');
  assert.match(summary.failures[0], /session cookie is missing secure/u);
  assert.equal(summary.requestCounts.POST, 1);
  assert.equal(summary.requestCounts.DELETE, 1);
  assert.equal(summary.sessionCleanup.status, 'PASS');
});

test('an authenticated health response must match the exact buildId', async () => {
  const fixture = fixtureRequest({ badBuild: true });
  const summary = await runOracleSmoke({ origin, token, buildId, request: fixture.request });
  assert.equal(summary.status, 'FAIL');
  assert.match(summary.failures[0], /health identity did not match/u);
  assert.equal(summary.requestCounts.POST, 1);
});

test('logout failure stays separate from successful and failed smoke results and redacts secrets', async () => {
  for (const badBuild of [false, true]) {
    const fixture = fixtureRequest({ badBuild, throwAt: '/api/session' });
    const summary = await runOracleSmoke({ origin, token, buildId, request: fixture.request });
    assert.equal(summary.status, badBuild ? 'FAIL' : 'PASS');
    assert.equal(summary.sessionCleanup.status, 'WARN');
    assert.match(summary.sessionCleanup.error, /\[redacted\]/u);
    assert.equal(JSON.stringify(summary).includes(token), false);
    assert.equal(JSON.stringify(summary).includes(session), false);
    if (badBuild) assert.match(summary.failures[0], /health identity did not match/u);
    else assert.deepEqual(summary.failures, []);
  }
});

test('real app smoke removes its session after success and failure while preserving a device login', async (t) => {
  const { createApp } = await import('../dist/server/app.js');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uimori-smoke-sessions-'));
  const dbPath = path.join(directory, 'app.sqlite');
  const app = await createApp({
    dbPath,
    publicOrigin: origin,
    accessToken: token,
    buildId,
    webRoot: path.resolve('dist/web'),
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = async ({ url, method, headers, body }) => {
    const response = await app.inject({
      method,
      url: `${url.pathname}${url.search}`,
      headers: { host: new URL(origin).host, ...headers },
      ...(body ? { payload: body } : {}),
    });
    return { status: response.statusCode, headers: response.headers, body: response.payload };
  };
  const device = await request({
    url: new URL('/api/session', origin),
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const deviceHeader = device.headers['set-cookie'];
  const deviceCookie = (Array.isArray(deviceHeader) ? deviceHeader[0] : deviceHeader).split(';')[0];
  for (const expectedBuild of [buildId, 'd'.repeat(64)]) {
    const result = await runOracleSmoke({ origin, token, buildId: expectedBuild, request });
    assert.equal(result.status, expectedBuild === buildId ? 'PASS' : 'FAIL');
    assert.equal(result.sessionCleanup.status, 'PASS');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT count(*) AS count FROM access_sessions').get().count, 1);
    } finally {
      db.close();
    }
  }
  const retained = await request({
    url: new URL('/api/session', origin),
    method: 'GET',
    headers: { Cookie: deviceCookie },
  });
  assert.equal(JSON.parse(retained.body).authenticated, true);
});

test('request failures and artifacts redact both access and session secrets', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uimori-oracle-smoke-'));
  const outputFile = path.join(directory, 'summary.json');
  try {
    const fixture = fixtureRequest({ throwAt: '/api/health' });
    const summary = await runOracleSmoke({
      origin,
      token,
      buildId,
      outputFile,
      request: fixture.request,
    });
    const artifact = await readFile(outputFile, 'utf8');
    assert.equal(summary.status, 'FAIL');
    assert.equal(artifact.includes(token), false);
    assert.equal(artifact.includes(session), false);
    assert.match(artifact, /\[redacted\]/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('error truncation happens after redaction so long tokens cannot leak a prefix', async () => {
  const longToken = 'secret-prefix-'.repeat(70);
  const summary = await runOracleSmoke({
    origin,
    token: longToken,
    buildId,
    request: async () => {
      throw new Error('upstream diagnostic '.repeat(10) + longToken);
    },
  });
  assert.equal(summary.status, 'FAIL');
  assert.equal(JSON.stringify(summary).includes('secret-prefix-'), false);
  assert.match(summary.failures[0], /\[redacted\]/u);
});

test('env reader accepts required values and rejects missing or duplicate keys', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uimori-oracle-env-'));
  try {
    const valid = path.join(directory, 'valid.env');
    await writeFile(
      valid,
      `# private deployment values\nUIMORI_PUBLIC_ORIGIN=${origin}\nUIMORI_ACCESS_TOKEN='${token}'\nOTHER=value\n`
    );
    assert.deepEqual(await readAccessEnv(valid), { origin, token });

    const duplicate = path.join(directory, 'duplicate.env');
    await writeFile(
      duplicate,
      `UIMORI_PUBLIC_ORIGIN=${origin}\nUIMORI_ACCESS_TOKEN=${token}\nUIMORI_ACCESS_TOKEN=second\n`
    );
    await assert.rejects(
      readAccessEnv(duplicate),
      /Duplicate environment key: UIMORI_ACCESS_TOKEN/u
    );

    const missing = path.join(directory, 'missing.env');
    await writeFile(missing, `UIMORI_PUBLIC_ORIGIN=${origin}\n`);
    await assert.rejects(readAccessEnv(missing), /Missing environment key: UIMORI_ACCESS_TOKEN/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
