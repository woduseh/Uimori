import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { probeSession } from './oracle-image-probe.mjs';

async function listener(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  return `http://127.0.0.1:${server.address().port}/api/session`;
}

test('loopback session probe sends the exact HTTPS-origin Host header on the wire', async (t) => {
  const received = [];
  const url = await listener(t, (request, response) => {
    received.push({ host: request.headers.host, path: request.url });
    if (request.headers.host !== 'oracle-probe.invalid') {
      response.writeHead(403).end('{}');
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ required: true, authenticated: false }));
  });
  assert.equal(await probeSession(url, 'oracle-probe.invalid'), true);
  assert.deepEqual(received, [{ host: 'oracle-probe.invalid', path: '/api/session' }]);
  assert.equal(await probeSession(url, 'wrong-host.invalid'), false);
});

test('probe rejects malformed, authenticated, unprotected and unsuccessful sessions', async (t) => {
  let status = 200;
  let body;
  const url = await listener(t, (_request, response) => response.writeHead(status).end(body));
  for (body of [
    'invalid json',
    'null',
    '{}',
    '{"required":true,"authenticated":true}',
    '{"required":false,"authenticated":false}',
  ]) {
    assert.equal(await probeSession(url, 'oracle-probe.invalid'), false, body);
  }
  body = '{"required":true,"authenticated":false}';
  status = 503;
  assert.equal(await probeSession(url, 'oracle-probe.invalid'), false);
});

test('probe deadline also bounds a response whose body never finishes', async (t) => {
  const url = await listener(t, (_request, response) => {
    response.writeHead(200);
    response.write('{"required":true');
  });
  assert.equal(await probeSession(url, 'oracle-probe.invalid', 50), false);
});
