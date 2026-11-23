import { fixtureBotInput } from './fixtures/chat.js';
import { afterEach, expect, test } from 'vitest';
import Fastify from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../server/app.js';
import { requestMetricsRoutes } from '../server/request-metrics.js';
import { instrumentDatabase } from '../server/sql-metrics.js';

const SERVER_TIMING = /^auth;dur=\d+\.\d, db;dur=\d+\.\d;desc="q=(\d+)", total;dur=\d+\.\d$/u;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function measuredServer() {
  const db = instrumentDatabase(new DatabaseSync(':memory:'));
  db.exec('CREATE TABLE items(id TEXT PRIMARY KEY)');
  const app = Fastify();
  const metrics = requestMetricsRoutes(app);
  metrics.addAuthenticationMark();
  app.get<{ Params: { id: string } }>('/api/items/:id', async (request) => {
    db.prepare('INSERT OR IGNORE INTO items VALUES(?)').run(request.params.id);
    await new Promise((resolve) => setTimeout(resolve, 1));
    return db.prepare('SELECT count(*) AS n FROM items').get();
  });
  app.post<{ Body: { id: string } }>('/api/items', async (request) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    db.prepare('INSERT OR IGNORE INTO items VALUES(?)').run(request.body.id);
    return db.prepare('SELECT count(*) AS n FROM items').get();
  });
  app.get('/api/stream', (_request, reply) => {
    reply.hijack();
    db.prepare('SELECT 1').get();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' });
    reply.raw.end('data: done\n\n');
  });
  app.get('/page', async () => 'page');
  cleanup.push(async () => {
    await app.close();
    db.close();
  });
  return app;
}

test('API responses carry durations and statement counts; metrics group by route pattern', async () => {
  const app = await measuredServer();
  const first = await app.inject({ url: '/api/items/private-item-a' });
  expect(first.headers['server-timing']).toMatch(SERVER_TIMING);
  expect(SERVER_TIMING.exec(String(first.headers['server-timing']))![1]).toBe('2');
  await app.inject({ url: '/api/items/private-item-b' });
  const stream = await app.inject({ url: '/api/stream' });
  expect(stream.body).toBe('data: done\n\n');
  expect(stream.headers['server-timing']).toBeUndefined();
  expect((await app.inject({ url: '/page' })).headers['server-timing']).toBeUndefined();

  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const posted = await fetch(`${address}/api/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'private-item-c' }),
  });
  expect(posted.headers.get('server-timing')).toMatch(SERVER_TIMING);
  expect(SERVER_TIMING.exec(posted.headers.get('server-timing')!)![1]).toBe('2');

  const metrics = await app.inject({ url: '/api/diagnostics/metrics' });
  expect(metrics.headers['cache-control']).toBe('no-store');
  expect(metrics.body).not.toContain('private-item');
  const routes = metrics.json().routes;
  expect(routes).toEqual([
    {
      method: 'GET',
      route: '/api/items/:id',
      count: 2,
      notModified: 0,
      errors: 0,
      durationMs: expect.objectContaining({ p50: expect.any(Number), p95: expect.any(Number) }),
      responseBytes: expect.objectContaining({ total: 2 * Buffer.byteLength('{"n":1}') }),
      sqlStatements: { p50: 2, p95: 2, max: 2 },
      sqlMs: expect.objectContaining({ p95: expect.any(Number) }),
    },
    expect.objectContaining({ method: 'POST', route: '/api/items', count: 1 }),
  ]);
});

test('the metrics endpoint requires the same authentication as other API routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-request-metrics-'));
  const accessToken = 'synthetic-metrics-access-token-0123456789';
  const publicOrigin = 'https://story.example.test';
  const app: App = await createApp({
    dbPath: join(directory, 'test.sqlite'),
    buildId: 'request-metrics-synthetic',
    publicOrigin,
    accessToken,
  });
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  cleanup.push(() => app.close());
  const headers = { host: 'story.example.test', origin: publicOrigin };
  for (const url of ['/api/diagnostics/metrics', '/api/%64iagnostics/metrics']) {
    const denied = await app.inject({ url, headers });
    expect(denied.statusCode).toBe(401);
    expect(denied.body).not.toContain('routes');
  }
  const login = await app.inject({
    method: 'POST',
    url: '/api/session',
    headers,
    payload: { token: accessToken },
  });
  const authed = { ...headers, cookie: String(login.headers['set-cookie']).split(';')[0]! };
  const owner = await app.inject({
    method: 'POST',
    url: '/api/content',
    headers: authed,
    payload: fixtureBotInput(),
  });
  const chat = await app.inject({
    method: 'POST',
    url: '/api/chats',
    headers: authed,
    payload: { title: 'Metrics synthetic story', botId: owner.json().id },
  });
  const read = await app.inject({ url: `/api/chats/${chat.json().id}`, headers: authed });
  expect(read.statusCode).toBe(200);
  expect(Number(SERVER_TIMING.exec(String(read.headers['server-timing']))![1])).toBeGreaterThan(0);

  const metrics = await app.inject({ url: '/api/diagnostics/metrics', headers: authed });
  expect(metrics.statusCode).toBe(200);
  expect(metrics.body).not.toContain(chat.json().id);
  expect(metrics.json().routes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ method: 'GET', route: '/api/chats/:id', count: 1 }),
      expect.objectContaining({ method: 'GET', route: '/api/diagnostics/metrics', errors: 2 }),
    ])
  );
});
