import { afterEach, expect, test, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleAuth } from 'google-auth-library';
import { Store } from '../server/store.js';
import { VertexCredentialStore } from '../server/vertex-credentials.js';
import { createApp, type App } from '../server/app.js';

const owned: { path: string; store?: Store; app?: App }[] = [];
const account = {
  type: 'service_account',
  project_id: 'synthetic-project',
  client_email: 'synthetic@synthetic-project.iam.gserviceaccount.com',
  private_key: generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey,
  token_uri: 'https://oauth2.googleapis.com/token',
};
const endpoint =
  'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models';
function database() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-vertex-db-'));
  const store = new Store(join(path, 'app.sqlite'));
  owned.push({ path, store });
  return store;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0)) {
    if (item.app) await item.app.close();
    else item.store?.close();
    rmSync(item.path, { recursive: true, force: true });
  }
});

test('saved service account lives in SQLite and survives reopening without network', async () => {
  const path = mkdtempSync(join(tmpdir(), 'uimori-vertex-http-'));
  let app = await createApp({ dbPath: join(path, 'app.sqlite'), buildId: 'test', testMode: true });
  const entry = { path, app };
  owned.push(entry);
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network'));
  const upload = await app.inject({
    method: 'POST',
    url: '/api/provider-management/vertex-credentials',
    payload: { serviceAccount: account },
  });
  expect(upload.statusCode, upload.body).toBe(200);
  expect(upload.body).not.toContain('PRIVATE KEY');
  expect(upload.json()).toEqual({
    projectId: account.project_id,
    clientEmail: account.client_email,
  });
  const saved = await app.inject({
    method: 'POST',
    url: '/api/connections',
    payload: {
      title: 'Vertex',
      protocol: 'vertex-gemini-v1',
      endpoint,
      serviceAccount: account,
      enabled: true,
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const reference = saved.json().credentialRef;
  expect(reference).toMatch(/^UIMORI_PROVIDER_VERTEX_FILE_[A-F0-9]{32}$/);
  expect(saved.body).not.toContain('PRIVATE KEY');
  expect(JSON.parse(app.store.credentials.get(reference)!).private_key).toBe(account.private_key);
  expect((await app.inject('/api/library')).body).not.toContain('PRIVATE KEY');
  await app.close();
  app = await createApp({ dbPath: join(path, 'app.sqlite'), buildId: 'test', testMode: true });
  entry.app = app;
  const reopened = (await app.inject('/api/library'))
    .json()
    .connections.find((item: { id: string }) => item.id === saved.json().id);
  expect(reopened.credentialRef).toBe(reference);
  expect(network).not.toHaveBeenCalled();
});
test('OAuth uses the registered account and validates its project', async () => {
  const db = database();
  const keys = new VertexCredentialStore(db.db);
  const ref = db.product.connection({
    title: 'Vertex',
    protocol: 'vertex-gemini-v1',
    endpoint,
    serviceAccount: account,
    enabled: true,
  }).credentialRef!;
  const connection = {
    id: 'vertex',
    protocol: 'vertex-gemini-v1' as const,
    endpoint,
    credentialRef: ref,
  };
  const token = vi
    .spyOn(GoogleAuth.prototype, 'getAccessToken')
    .mockResolvedValue('synthetic-token');
  expect(await keys.accessToken(connection, new AbortController().signal)).toBe('synthetic-token');
  await expect(
    keys.resolve(
      ref,
      { ...connection, endpoint: endpoint.replace('synthetic-project', 'different') },
      new AbortController().signal
    )
  ).rejects.toThrow();
  await expect(keys.resolve(ref, connection, AbortSignal.abort())).rejects.toThrow();
  expect(token).toHaveBeenCalledTimes(1);
});

test('direct connection saves reject missing or mismatched saved Vertex accounts', () => {
  const store = database();
  const input = { title: 'Vertex', protocol: 'vertex-gemini-v1', endpoint, enabled: true };
  const missing = 'UIMORI_PROVIDER_VERTEX_FILE_' + 'A'.repeat(32);
  expect(() => store.product.connection({ ...input, credentialRef: missing })).toThrow(
    '서비스 계정을 먼저 등록'
  );
  expect(store.product.all('connection')).toEqual([]);

  const saved = store.product.connection({ ...input, serviceAccount: account });
  expect(() =>
    store.product.connection(
      {
        ...input,
        endpoint: endpoint.replace('synthetic-project', 'different'),
        credentialRef: saved.credentialRef,
        expectedRevision: saved.revision,
      },
      saved.id
    )
  ).toThrow('프로젝트가 달라요');
  expect(store.product.get('connection', saved.id)).toEqual(saved);
  expect(JSON.parse(store.credentials.get(saved.credentialRef)!).private_key).toBe(
    account.private_key
  );
});

test('validating a draft and failing to save never persists its service account', async () => {
  const path = mkdtempSync(join(tmpdir(), 'uimori-vertex-draft-'));
  const app = await createApp({
    dbPath: join(path, 'app.sqlite'),
    buildId: 'test',
    testMode: true,
  });
  owned.push({ path, app });
  const validate = await app.inject({
    method: 'POST',
    url: '/api/provider-management/vertex-credentials',
    payload: { serviceAccount: account },
  });
  expect(validate.statusCode, validate.body).toBe(200);
  expect(validate.json()).toEqual({
    projectId: account.project_id,
    clientEmail: account.client_email,
  });
  const vertexRows = () =>
    app.store.db
      .prepare("SELECT id FROM credentials WHERE id LIKE 'UIMORI_PROVIDER_VERTEX_FILE_%'")
      .all();
  expect(vertexRows()).toEqual([]);
  const failed = await app.inject({
    method: 'POST',
    url: '/api/connections',
    payload: {
      title: 'Vertex',
      protocol: 'vertex-gemini-v1',
      endpoint: endpoint.replace('synthetic-project', 'different'),
      serviceAccount: account,
      enabled: true,
    },
  });
  expect(failed.statusCode).toBe(400);
  expect(vertexRows()).toEqual([]);
  expect(app.store.product.all('connection')).toEqual([]);

  for (const invalid of [
    {
      title: 'Other provider',
      protocol: 'openai-chat-v1',
      endpoint: 'https://example.invalid/v1',
      serviceAccount: account,
    },
    {
      title: 'Vertex',
      protocol: 'vertex-gemini-v1',
      endpoint,
      serviceAccount: { ...account, private_key: account.private_key + 'X'.repeat(64 * 1024) },
    },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/connections',
      payload: invalid,
    });
    expect(response.statusCode).toBe(400);
    expect(vertexRows()).toEqual([]);
    expect(app.store.product.all('connection')).toEqual([]);
  }

  // Simulate a credential write failure after the connection row has been prepared.
  app.store.db.exec(`CREATE TEMP TRIGGER fail_vertex_write BEFORE INSERT ON credentials
    WHEN NEW.id GLOB 'UIMORI_PROVIDER_VERTEX_FILE_*'
    BEGIN SELECT RAISE(ABORT, 'simulated credential write failure'); END`);
  const writeFailure = await app.inject({
    method: 'POST',
    url: '/api/connections',
    payload: {
      title: 'Vertex',
      protocol: 'vertex-gemini-v1',
      endpoint,
      serviceAccount: account,
      enabled: true,
    },
  });
  expect(writeFailure.statusCode).toBe(500);
  expect(vertexRows()).toEqual([]);
  expect(app.store.product.all('connection')).toEqual([]);
});

test('replacement is atomic and preserves the previous shared service account', async () => {
  const path = mkdtempSync(join(tmpdir(), 'uimori-vertex-replace-'));
  const app = await createApp({
    dbPath: join(path, 'app.sqlite'),
    buildId: 'test',
    testMode: true,
  });
  owned.push({ path, app });
  const input = { title: 'Vertex', protocol: 'vertex-gemini-v1', endpoint, enabled: true };
  const first = await app.inject({
    method: 'POST',
    url: '/api/connections',
    payload: { ...input, serviceAccount: account },
  });
  expect(first.statusCode, first.body).toBe(200);
  const original = first.json();
  const shared = await app.inject({
    method: 'POST',
    url: '/api/connections',
    payload: { ...input, credentialRef: original.credentialRef },
  });
  expect(shared.statusCode, shared.body).toBe(200);
  const replacement = {
    ...account,
    client_email: 'replacement@synthetic-project.iam.gserviceaccount.com',
  };
  const update = { ...input, serviceAccount: replacement, expectedRevision: original.revision };
  const conflict = await app.inject({
    method: 'PUT',
    url: `/api/connections/${original.id}`,
    payload: { ...update, expectedRevision: original.revision + 1 },
  });
  expect(conflict.statusCode).toBe(409);
  expect(
    app.store.db
      .prepare("SELECT id FROM credentials WHERE id LIKE 'UIMORI_PROVIDER_VERTEX_FILE_%'")
      .all()
  ).toHaveLength(1);
  const saved = await app.inject({
    method: 'PUT',
    url: `/api/connections/${original.id}`,
    payload: update,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json().credentialRef).not.toBe(original.credentialRef);
  expect(JSON.parse(app.store.credentials.get(saved.json().credentialRef)!).client_email).toBe(
    replacement.client_email
  );
  expect(JSON.parse(app.store.credentials.get(original.credentialRef)!).client_email).toBe(
    account.client_email
  );
  expect(app.store.product.get('connection', shared.json().id)).toMatchObject({
    credentialRef: original.credentialRef,
  });
});
