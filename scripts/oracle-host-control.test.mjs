import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { localRequest, controlMaintenance } from './oracle-host-control.mjs';

async function server(t, handler) {
  const listener = createServer(handler);
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        listener.closeAllConnections();
        listener.close(resolve);
      })
  );
  return `http://127.0.0.1:${listener.address().port}`;
}

test('host control sends exact public Host/Origin on real loopback HTTP', async (t) => {
  const seen = [];
  const endpoint = await server(t, (request, response) => {
    seen.push({
      host: request.headers.host,
      origin: request.headers.origin,
      cookie: request.headers.cookie,
    });
    response.end(JSON.stringify({ status: 'open' }));
  });
  const result = await localRequest({
    origin: 'https://synthetic.example:8443',
    endpoint,
    pathname: '/api/maintenance',
    cookie: 'uimori_session=synthetic',
  });
  assert.equal(result.status, 200);
  assert.deepEqual(seen, [
    {
      host: 'synthetic.example:8443',
      origin: 'https://synthetic.example:8443',
      cookie: 'uimori_session=synthetic',
    },
  ]);
});

test('host control deadlines bound stalled response bodies', async (t) => {
  const endpoint = await server(t, (_request, response) => {
    response.writeHead(200);
    response.write('{');
  });
  await assert.rejects(
    localRequest({ origin: 'https://example.test', endpoint, pathname: '/', timeoutMs: 30 }),
    /timeout/
  );
});

test('real built app closes admission, keeps reads, preserves gate on restart and reopens only its own gate', async (t) => {
  const { createApp } = await import('../dist/server/app.js');
  const directory = await mkdtemp(join(tmpdir(), 'uimori-host-control-'));
  const origin = 'https://host-control.invalid';
  const token = 'synthetic-oracle-control-token-0123456789';
  const owner = 'oracle:synthetic-test';
  let app;
  t.after(async () => {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function boot() {
    app = await createApp({
      dbPath: join(directory, 'uimori.sqlite'),
      buildId: 'control-test',
      publicOrigin: origin,
      accessToken: token,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const endpoint = `http://127.0.0.1:${app.server.address().port}`;
    return (options) => localRequest({ ...options, endpoint });
  }
  let request = await boot();
  const device = await request({
    origin,
    pathname: '/api/session',
    method: 'POST',
    body: { token },
  });
  const deviceCookie = device.headers['set-cookie'][0].split(';')[0];
  const sessions = () => {
    const db = new DatabaseSync(join(directory, 'uimori.sqlite'), { readOnly: true });
    try {
      return db.prepare('SELECT count(*) AS count FROM access_sessions').get().count;
    } finally {
      db.close();
    }
  };
  const action = (name) => controlMaintenance({ action: name, origin, token, owner, request });
  assert.equal((await action('status')).status, 'open');
  assert.equal(sessions(), 1);
  const closed = await action('close');
  assert.equal(closed.reason, owner);
  assert.equal((await action('close')).epoch, closed.epoch);
  await assert.rejects(
    controlMaintenance({ action: 'open', origin, token, owner: 'oracle:other', request }),
    /another operator/
  );
  assert.equal(sessions(), 1);
  await app.close();
  request = await boot();
  assert.equal((await action('status')).status, 'closed');
  assert.equal((await action('open')).status, 'open');
  assert.equal((await action('status')).status, 'open');
  assert.equal(sessions(), 1);
  assert.equal(
    (await request({ origin, pathname: '/api/session', cookie: deviceCookie })).body.authenticated,
    true
  );

  const logoutUnavailable = (options) =>
    options.method === 'DELETE' ? Promise.resolve({ status: 503, body: {} }) : request(options);
  const confirmed = await controlMaintenance({
    action: 'close',
    origin,
    token,
    owner,
    request: logoutUnavailable,
  });
  assert.equal(confirmed.status, 'closed');
  assert.equal(confirmed.sessionCleanup.status, 'WARN');
  assert.match(confirmed.sessionCleanup.error, /HTTP 503/u);
  assert.equal(sessions(), 2);
  await assert.rejects(
    controlMaintenance({
      action: 'open',
      origin,
      token,
      owner: 'oracle:other',
      request: logoutUnavailable,
    }),
    (error) => {
      assert.match(error.message, /Maintenance belongs to another operator/u);
      assert.match(error.message, /temporary session cleanup/u);
      assert.equal(error.sessionCleanup.status, 'WARN');
      return true;
    }
  );
  assert.equal(sessions(), 3);
});
