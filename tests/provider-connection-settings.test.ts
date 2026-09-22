import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, type App } from '../server/app.js';
import type { Connection } from '../core/product.js';

const owned: { directory: string; app: App }[] = [];
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('Saving connection settings never contacts a provider')
  );
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  for (const item of owned.splice(0)) {
    await item.app.close();
    await rm(item.directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
async function setup(accessToken?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-connection-settings-'));
  const app = await createApp({
    dbPath: join(directory, 'app.sqlite'),
    buildId: 'connection-settings',
    accessToken,
  });
  owned.push({ directory, app });
  return app;
}
function input(endpoint: string, protocol = 'openai-chat-v1') {
  return { title: 'Owner configured connection', endpoint, protocol, enabled: true };
}

test.each([
  ['openai-chat-v1', 'http://192.168.1.25:8080/v1'],
  ['openai-responses-v1', 'https://gateway.example/v1'],
  ['anthropic-messages-v1', 'https://anthropic-compatible.example/v1'],
  ['deepseek-chat-v1', 'https://deepseek-compatible.example/v1'],
  ['vercel-chat-v1', 'https://gateway.example/v1'],
])(
  '%s accepts an owner-configured endpoint and direct key in one save',
  async (protocol, endpoint) => {
    const app = await setup();
    const apiKey = 'synthetic-private-api-key';
    const response = await app.inject({
      method: 'POST',
      url: '/api/connections',
      payload: { ...input(endpoint, protocol), apiKey },
    });
    expect(response.statusCode, response.body).toBe(200);
    const saved: Connection = response.json();
    expect(saved.endpoint).toBe(endpoint);
    expect(saved.credentialRef).toBeTruthy();
    expect(app.store.credentials.get(saved.credentialRef!)).toBe(apiKey);
    expect(response.body).not.toContain(apiKey);
    expect((await app.inject({ method: 'GET', url: '/api/library' })).body).not.toContain(apiKey);
  }
);

test('editing a name retains the key; replacing or clearing the key updates the database immediately', async () => {
  const app = await setup();
  const original = app.store.product.connection({
    ...input('http://127.0.0.1:8080/v1'),
    apiKey: 'first-private-key',
  }) as Connection;
  const renamed = app.store.product.connection(
    { ...input(original.endpoint), title: 'Renamed', expectedRevision: original.revision },
    original.id
  ) as Connection;
  expect(app.store.credentials.get(renamed.credentialRef!)).toBe('first-private-key');
  const replaced = app.store.product.connection(
    {
      ...input(original.endpoint),
      expectedRevision: renamed.revision,
      apiKey: 'second-private-key',
    },
    original.id
  ) as Connection;
  expect(app.store.credentials.get(replaced.credentialRef!)).toBe('second-private-key');
  const cleared = app.store.product.connection(
    { ...input(original.endpoint), expectedRevision: replaced.revision, apiKey: null },
    original.id
  ) as Connection;
  expect(cleared.credentialRef).toBeUndefined();
  expect(app.store.credentials.get(original.credentialRef!)).toBeUndefined();
  expect(app.store.credentials.get(replaced.credentialRef!)).toBeUndefined();
});

test.each([
  'not a URL',
  'file:///tmp/api',
  'https://user:password@example.com/v1',
  'https://example.com/v1?api_key=secret',
  'https://example.com/v1#fragment',
])('invalid API root %s does not create settings', async (endpoint) => {
  const app = await setup();
  const response = await app.inject({
    method: 'POST',
    url: '/api/connections',
    payload: input(endpoint),
  });
  expect(response.statusCode).toBe(400);
  expect(app.store.product.all('connection')).toEqual([]);
});

test('connection writes still require the workspace login, not a second per-origin approval', async () => {
  const token = 'synthetic-access-token-for-settings';
  const app = await setup(token);
  const payload = { ...input('http://192.168.1.25:8080/v1'), apiKey: 'private-provider-key' };
  expect((await app.inject({ method: 'POST', url: '/api/connections', payload })).statusCode).toBe(
    401
  );
  const login = await app.inject({ method: 'POST', url: '/api/session', payload: { token } });
  expect(login.statusCode).toBe(200);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const saved = await app.inject({
    method: 'POST',
    url: '/api/connections',
    headers: { cookie },
    payload,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.body).not.toContain(payload.apiKey);
});
