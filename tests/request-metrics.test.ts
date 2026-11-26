import { fixtureBotInput } from './fixtures/chat.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../server/app.js';

const SERVER_TIMING = /^auth;dur=\d+\.\d, db;dur=\d+\.\d;desc="q=(\d+)", total;dur=\d+\.\d$/u;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
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
