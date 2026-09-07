// Standalone process keeps virtual HTTP timers out of other provider tests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { mock } from 'node:test';
import { Agent, getGlobalDispatcher } from 'undici';
import { providerFetchOptions, transportFailureCode } from '../../core/provider-fetch.ts';

const phase = process.argv[2];
assert.ok(['headers', 'body'].includes(phase));
const secret = 'synthetic-clock-secret-never-a-real-key';
const pendingResponses = new Map();
const seen = [];
const headersSeen = new Set();
const outcomes = new Map();
const baseline = new Agent();
const controller = new AbortController();
const init = {
  method: 'POST',
  body: 'synthetic request',
  headers: { authorization: `Bearer ${secret}` },
  signal: controller.signal,
  redirect: 'error',
};
const globalDispatcher = getGlobalDispatcher();
const fixedInit = providerFetchOptions(init);
assert.equal(getGlobalDispatcher(), globalDispatcher);
assert.equal(fixedInit.signal, controller.signal);
const server = createServer(async (request, response) => {
  for await (const _chunk of request) {
    /* Fully consume this synthetic request. */
  }
  assert.equal(request.headers.authorization, `Bearer ${secret}`);
  seen.push(request.url);
  pendingResponses.set(request.url, response);
  if (phase === 'body') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('first fragment; ');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const io = async (predicate) => {
  for (let turn = 0; turn < 2000 && !predicate(); turn++) {
    mock.timers.tick(1);
    await nextTurn();
  }
  assert.ok(predicate(), 'Local network did not reach the requested test state');
};
const advance = async (milliseconds) => {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 500) {
    mock.timers.tick(500);
    await nextTurn();
  }
};
let requests = [];
try {
  mock.timers.enable({ apis: ['setTimeout'] });
  // Node 24 MockTimers' refresh does not repeatedly schedule Undici's fast
  // timer. Use its supported optional-refresh fallback, only in this process.
  const mockedSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (...args) => {
    const timer = mockedSetTimeout(...args);
    timer.refresh = undefined;
    return timer;
  };
  const start = (name, options) =>
    fetch(`${origin}/${name}`, options)
      .then((response) => {
        headersSeen.add(name);
        return response.text();
      })
      .then(
        (text) => outcomes.set(name, { status: 'completed', text }),
        (error) => outcomes.set(name, { status: 'error', code: transportFailureCode(error) })
      );
  requests = [start('baseline', { ...init, dispatcher: baseline }), start('fixed', fixedInit)];
  await io(() => seen.length === 2 && (phase === 'headers' || headersSeen.size === 2));
  await advance(295_000);
  assert.equal(
    outcomes.size,
    0,
    'Neither request should reach its header/body deadline before 300 seconds'
  );
  await advance(20_000);
  const code = phase === 'headers' ? 'UND_ERR_HEADERS_TIMEOUT' : 'UND_ERR_BODY_TIMEOUT';
  await io(() => outcomes.has('baseline'));
  assert.deepEqual(outcomes.get('baseline'), { status: 'error', code });
  assert.equal(
    outcomes.has('fixed'),
    false,
    'The app deadline remains in charge after the idle-timeout boundary'
  );
  pendingResponses.get('/fixed').end('completed after virtual 315 seconds');
  await Promise.all(requests);
  assert.equal(outcomes.get('fixed').status, 'completed');
  assert.ok(outcomes.get('fixed').text.endsWith('completed after virtual 315 seconds'));
  assert.deepEqual(seen.sort(), ['/baseline', '/fixed']);
  assert.equal(getGlobalDispatcher(), globalDispatcher);
  assert.equal(JSON.stringify([...outcomes]).includes(secret), false);
  process.stdout.write(
    JSON.stringify({
      phase,
      beforeSeconds: 295,
      afterSeconds: 315,
      baselineCode: code,
      fixedStatus: 'completed',
      requests: 2,
      requestRetries: 0,
      globalDispatcherUnchanged: true,
      secretLeaked: false,
    })
  );
} finally {
  controller.abort();
  await baseline.destroy();
  await fixedInit.dispatcher.destroy();
  await Promise.allSettled(requests);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  mock.timers.reset();
}
