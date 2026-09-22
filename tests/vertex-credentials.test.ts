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

test('uploaded service account lives in SQLite and survives reopening without network', async () => {
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
  const reference = upload.json().credentialRef;
  const saved = await app.inject({
    method: 'POST',
    url: '/api/connections',
    payload: {
      title: 'Vertex',
      protocol: 'vertex-gemini-v1',
      endpoint,
      credentialRef: reference,
      enabled: true,
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(JSON.parse(app.store.credentials.get(reference)!).private_key).toBe(account.private_key);
  expect((await app.inject('/api/library')).body).not.toContain('PRIVATE KEY');
  await app.close();
  app = await createApp({ dbPath: join(path, 'app.sqlite'), buildId: 'test', testMode: true });
  entry.app = app;
  expect(
    (await app.inject(`/api/provider-management/connections/${saved.json().id}/readiness`)).json()
      .credentialStatus
  ).toBe('configured');
  expect(network).not.toHaveBeenCalled();
});
test('OAuth uses the registered account and validates its project', async () => {
  const db = database();
  const keys = new VertexCredentialStore(db.db);
  const ref = keys.upload(account).credentialRef;
  const connection = {
    id: 'vertex',
    protocol: 'vertex-gemini-v1' as const,
    endpoint,
    credentialRef: ref,
  };
  const token = vi
    .spyOn(GoogleAuth.prototype, 'getAccessToken')
    .mockResolvedValue('synthetic-token');
  expect(await keys.resolve(ref, connection, new AbortController().signal)).toBe('synthetic-token');
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
