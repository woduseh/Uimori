import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { GoogleAuth } from 'google-auth-library';
import { createApp, type App } from '../server/app.js';
import type { Connection } from '../core/product.js';

const owned: { directory: string; app?: App }[] = [];
const official = [
  { protocol: 'vertex-gemini-v1', endpoint: 'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models' },
  { protocol: 'openai-responses-v1', endpoint: 'https://api.openai.com/v1' },
  { protocol: 'openai-chat-v1', endpoint: 'https://api.openai.com/v1' },
  { protocol: 'anthropic-messages-v1', endpoint: 'https://api.anthropic.com/v1' },
  { protocol: 'vercel-chat-v1', endpoint: 'https://ai-gateway.vercel.sh/v1' },
];
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external request'));
  vi.spyOn(GoogleAuth.prototype, 'getClient').mockRejectedValue(new Error('Unexpected credential resolution'));
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  expect(GoogleAuth.prototype.getClient).not.toHaveBeenCalled();
  for (const item of owned.splice(0).reverse()) {
    await item.app?.close();
    const target = resolve(item.directory), within = relative(resolve(tmpdir()), target);
    if (isAbsolute(within) || within.startsWith('..') || !basename(target).startsWith('uimori-endpoint-status-')) throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
async function setup(approvedOrigins: string[] = [], accessToken?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-endpoint-status-'));
  const item: (typeof owned)[number] = { directory }; owned.push(item);
  const app = item.app = await createApp({ dbPath: join(directory, 'test.sqlite'), buildId: 'endpoint-status-test', approvedOrigins, accessToken });
  await app.ready(); return app;
}
const post = (app: App, payload: Record<string, unknown>, cookie?: string) => app.inject({ method: 'POST', url: '/api/provider-management/endpoint-status', headers: { host: '127.0.0.1', ...(cookie ? { cookie } : {}) }, payload });
const settings = (app: App) => app.store.db.prepare('SELECT * FROM provider_settings ORDER BY id').all();

test('official endpoints are approved without environment configuration or saving the draft', async () => {
  const app = await setup(); const before = settings(app);
  for (const payload of official) {
    const response = await post(app, payload);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ status: 'official', origin: new URL(payload.endpoint).origin });
  }
  expect(settings(app)).toEqual(before);
  expect(app.store.db.prepare('SELECT COUNT(*) AS n FROM provider_connection_tests').get()).toEqual({ n: 0 });
});

test('custom origins distinguish configured and needs-approval without mutating saved settings', async () => {
  const app = await setup(['https://configured.synthetic.invalid']);
  const saved = app.store.product.connection({ title: 'Existing custom connection', protocol: 'openai-chat-v1', endpoint: 'https://configured.synthetic.invalid/v1', enabled: true }) as Connection;
  app.store.product.model({ title: 'Existing model', connectionId: saved.id, modelId: 'synthetic', maxOutputTokens: 1000, temperature: null });
  const before = settings(app);
  for (const [origin, status] of [['https://configured.synthetic.invalid', 'configured'], ['https://unapproved.synthetic.invalid', 'needs-approval']]) {
    const response = await post(app, { protocol: 'openai-chat-v1', endpoint: `${origin}/v1` });
    expect(response.statusCode, response.body).toBe(200); expect(response.json()).toEqual({ status, origin });
  }
  expect(settings(app)).toEqual(before);
});

test('malformed and protocol-mismatched endpoints cannot report approval even for configured origins', async () => {
  const app = await setup(['https://api.openai.com']);
  for (const payload of [
    { protocol: 'openai-chat-v1', endpoint: 'not a URL' },
    { protocol: 'openai-chat-v1', endpoint: 'https://api.openai.com/v1?key=synthetic' },
    { protocol: 'openai-chat-v1', endpoint: 'https://api.openai.com/v1#fragment' },
    { protocol: 'openai-chat-v1', endpoint: 'https://user:password@api.openai.com/v1' },
    { protocol: 'anthropic-messages-v1', endpoint: 'https://api.openai.com/v1' },
    { protocol: 'vertex-gemini-v1', endpoint: 'https://aiplatform.googleapis.com/v1' },
    { protocol: 'vertex-gemini-v1', endpoint: 'https://us-central1-aiplatform.googleapis.com/v1/projects/synthetic-project/locations/us-central1/publishers/google/models' },
  ]) {
    const response = await post(app, payload);
    expect(response.statusCode, response.body).toBe(200); expect(response.json()).toEqual({ status: 'invalid', origin: null });
  }
  expect(settings(app)).toEqual([]);
});

test('unsupported protocols and invalid request fields return 400', async () => {
  const app = await setup();
  for (const payload of [{}, { ...official[0], protocol: 'unsupported' }, { ...official[0], endpoint: 42 }, { ...official[0], endpoint: '' }, { ...official[0], credentialEnv: 'UNREQUESTED_SECRET' }]) {
    expect((await post(app, payload)).statusCode).toBe(400);
  }
  expect(settings(app)).toEqual([]);
});

test('the local Codex endpoint does not require an HTTP origin', async () => {
  const app = await setup(); const response = await post(app, { protocol: 'codex-app-server-v1', endpoint: 'codex://local' });
  expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ status: 'local', origin: null });
});

test('saved official connections report originApproved with an empty configured origin list', async () => {
  const app = await setup();
  for (const payload of official) {
    const connection = app.store.product.connection({ title: 'Official readiness', ...payload, enabled: true }) as Connection;
    const before = settings(app);
    const response = await app.inject({ method: 'GET', url: `/api/provider-management/connections/${connection.id}/readiness`, headers: { host: '127.0.0.1' } });
    expect(response.statusCode, response.body).toBe(200); expect(response.json()).toMatchObject({ originApproved: true });
    expect(settings(app)).toEqual(before);
  }
});

test('endpoint inspection requires a session when application authentication is enabled', async () => {
  const token = 'synthetic-endpoint-access-token-123456'; const app = await setup([], token);
  expect((await post(app, official[0])).statusCode).toBe(401);
  const login = await app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1' }, payload: { token } });
  expect(login.statusCode, login.body).toBe(200);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const response = await post(app, official[0], cookie);
  expect(response.statusCode, response.body).toBe(200); expect(response.json().status).toBe('official');
  expect(settings(app)).toEqual([]);
});
