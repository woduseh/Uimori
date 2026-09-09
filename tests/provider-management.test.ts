import { updateTestProfile } from './fixtures/model-workspace.js';
import { createFixtureChat } from './fixtures/chat.js';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { readiness, managementImpact } from '../server/provider-management.js';
import type { Connection, ModelPreset } from '../core/product.js';

const owned: { directory: string; store: Store }[] = [];
const database = () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-management-'));
  const store = new Store(join(directory, 'test.sqlite'));
  owned.push({ directory, store });
  return store;
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const { directory, store } of owned.splice(0).reverse()) {
    store.close();
    const target = resolve(directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-management-')
    )
      throw new Error('Unsafe test cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});
const connectionBody = (extra: Record<string, unknown> = {}) => ({
  title: 'Synthetic',
  protocol: 'openai-chat-v1',
  endpoint: 'http://127.0.0.1:9999/v1',
  enabled: true,
  ...extra,
});
const editConnection = (c: Connection, extra: Record<string, unknown> = {}) =>
  connectionBody({
    title: c.title,
    protocol: c.protocol,
    endpoint: c.endpoint,
    enabled: c.enabled,
    ...(c.credentialEnv ? { credentialEnv: c.credentialEnv } : {}),
    expectedRevision: c.revision,
    ...extra,
  });
const modelBody = (c: Connection, extra: Record<string, unknown> = {}) => ({
  title: 'Model',
  connectionId: c.id,
  modelId: 'synthetic',
  maxOutputTokens: 1000,
  temperature: null,
  ...extra,
});
const ref = ({ id }: { id: string }) => ({ id });
const count = (s: Store) =>
  Number((s.db.prepare('SELECT COUNT(*) AS n FROM provider_settings').get() as { n: number }).n);
const stamp = '2026-09-07T00:00:00.000Z';

test('prepare is read only and create/update enforce the same CAS contract', () => {
  const s = database();
  const p = s.product;
  expect(p.prepareConnection(connectionBody()).value.catalog).toEqual([]);
  expect(count(s)).toBe(0);
  const c = p.connection(connectionBody()) as Connection;
  expect(p.prepareModel(modelBody(c)).value.source).toEqual({
    kind: 'manual',
    catalogUpdatedAt: null,
  });
  expect(count(s)).toBe(1);
  const m = p.model(modelBody(c)) as ModelPreset;
  const prepared = p.prepareModel(modelBody(c, { expectedRevision: 1, enabled: false }), m.id);
  expect(count(s)).toBe(2);
  expect(prepared.value.enabled).toBe(false);
  const updated = p.model(modelBody(c, { expectedRevision: 1, enabled: false }), m.id);
  expect(updated).toMatchObject(prepared.value);
  expect(() => p.prepareModel(modelBody(c, { expectedRevision: 1 }), m.id)).toThrow(
    'Revision conflict'
  );
  expect(() => p.model(modelBody(c, { expectedRevision: 1 }), m.id)).toThrow('Revision conflict');
  expect(() => p.prepareModel(modelBody(c), m.id)).toThrow('Invalid revision');
  expect(() => p.connection(connectionBody(), c.id)).toThrow('Invalid revision');
  p.connection(editConnection(c, { title: 'Renamed' }), c.id);
  expect(() => p.prepareConnection(editConnection(c), c.id)).toThrow('Revision conflict');
  expect(() => p.connection(editConnection(c), c.id)).toThrow('Revision conflict');
  expect(p.get<ModelPreset>('model', m.id)).toEqual(updated);
  expect(() => p.get<ModelPreset>('model', m.id, 1)).toThrow('Setting not found');
  expect(count(s)).toBe(2);
  expect(
    s.db.prepare("SELECT COUNT(*) AS n FROM versions WHERE kind IN ('model','connection')").get()
  ).toEqual({ n: 0 });
});

test('catalog/error retention uses credential authority and old connection execution is revoked', () => {
  const s = database();
  const p = s.product;
  const c = p.connection(
    connectionBody({ credentialEnv: 'NARRATIVE_PROVIDER_TEST_A' })
  ) as Connection;
  const cached = p.save(
    'connection',
    {
      ...c,
      catalog: [
        { id: 'synthetic', name: 'Synthetic', capabilities: { tools: null }, priceRevision: null },
      ],
      catalogUpdatedAt: stamp,
      catalogError: 'CATALOG_FAILED',
    },
    c.id,
    c.revision
  ) as Connection;
  const rename = p.connection(editConnection(cached, { title: 'Renamed' }), c.id) as Connection;
  expect(rename).toMatchObject({
    catalog: cached.catalog,
    catalogUpdatedAt: stamp,
    catalogError: 'CATALOG_FAILED',
  });
  const changed = p.connection(
    editConnection(rename, { credentialEnv: 'NARRATIVE_PROVIDER_TEST_B' }),
    c.id
  ) as Connection;
  expect(changed).toMatchObject({ catalog: [], catalogUpdatedAt: null, catalogError: null });
  expect(() => p.authorize(cached)).toThrow('authority changed');
  expect(p.get('connection', cached.id)).toEqual(changed);
  expect(() => p.get('connection', cached.id, cached.revision)).toThrow('Setting not found');
  expect(cached).toMatchObject({
    catalog: rename.catalog,
    credentialEnv: 'NARRATIVE_PROVIDER_TEST_A',
  });
  const disabled = p.connection(editConnection(changed, { enabled: false }), c.id) as Connection;
  expect(() => p.authorize(changed)).toThrow('disabled');
  expect(disabled.enabled).toBe(false);
});

test('model metadata is server sourced and disabling blocks new selection while preserving a captured run', () => {
  const s = database();
  const p = s.product;
  const chat = createFixtureChat(s, 'Metadata only');
  const c = p.connection(connectionBody()) as Connection;
  const cached = p.save(
    'connection',
    {
      ...c,
      catalog: [{ id: 'synthetic', name: 'Synthetic', capabilities: {}, priceRevision: null }],
      catalogUpdatedAt: stamp,
    },
    c.id,
    c.revision
  ) as Connection;
  const pricing = {
    mode: 'manual',
    rates: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3 },
  };
  const m = p.model(modelBody(cached, { enabled: true, pricing })) as ModelPreset;
  expect(m.pricing).toEqual(pricing);
  expect(m.source).toEqual({ kind: 'catalog', catalogUpdatedAt: stamp });
  const profile = p.profile(chat.id);
  const { chatId: _chatId, revision: _revision, ...profileBody } = profile;
  updateTestProfile(p, chat.id, {
    ...profileBody,
    expectedRevision: profile.revision,
    routes: { ...profile.routes, main: ref(m) },
  });
  const captured = p.snapshot(chat.id)!;
  const run = s.createRun(
    chat.id,
    {
      request: 'Synthetic captured settings',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: 'captured-settings',
    },
    (current) => ({
      chatId: chat.id,
      parentRevision: current.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request: 'Synthetic captured settings',
      history: [],
      resources: p.resources(chat.id, captured),
      profile: captured,
    })
  ).run;
  const frozen = structuredClone(run.snapshot);
  p.model(
    modelBody(cached, {
      enabled: false,
      expectedRevision: m.revision,
      pricing: { ...pricing, rates: { ...pricing.rates, input: 4 } },
    }),
    m.id
  );
  expect(() => p.snapshot(chat.id)).toThrow('Model disabled');
  expect(s.run(run.id).snapshot).toEqual(frozen);
  expect(s.run(run.id).snapshot.profile?.models.main).toMatchObject({ ...m, connection: cached });
  expect(s.run(run.id).snapshot.profile?.models.main?.pricingSnapshot).toMatchObject({
    source: 'manual',
    rates: pricing.rates,
  });
  expect(p.get<ModelPreset>('model', m.id).pricing).toMatchObject({ rates: { input: 4 } });
  expect(p.profile(chat.id).routes.main).toEqual({ id: m.id });
  expect(p.authorize(cached)).toEqual(cached);
  for (const pricing of [
    null,
    { mode: 'manual' },
    { mode: 'manual', rates: { input: -1, output: 8, cacheRead: 0.5, cacheWrite: 3 } },
    { mode: 'manual', rates: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3 }, grant: true },
  ])
    expect(() => p.model(modelBody(cached, { pricing }))).toThrow();
  expect(() => p.model(modelBody(cached, { source: m.source }))).toThrow('Unknown request field');
  expect(() => p.model(modelBody(cached, { enabled: null }))).toThrow('Invalid boolean');
});

test('archive roundtrip retains management metadata, strips authority, and rejects forged metadata atomically', () => {
  const s = database();
  const p = s.product;
  const c = p.connection(
    connectionBody({ credentialEnv: 'NARRATIVE_PROVIDER_TEST_A' })
  ) as Connection;
  const m = p.model(
    modelBody(c, {
      enabled: false,
      pricing: { mode: 'manual', rates: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3 } },
    })
  ) as ModelPreset;
  const archive = p.export();
  const restored = database();
  restored.product.import(archive);
  expect(restored.product.get('model', m.id)).toEqual(m);
  expect(restored.product.get<Connection>('connection', c.id)).toMatchObject({
    enabled: false,
    catalogUpdatedAt: null,
  });
  expect(restored.product.get('connection', c.id)).not.toHaveProperty('credentialEnv');
  expect(p.get<Connection>('connection', c.id).credentialEnv).toBe('NARRATIVE_PROVIDER_TEST_A');
  for (const mutate of [
    (body: any) => {
      body.source.connectionRevision = 999;
    },
    (body: any) => {
      body.source.kind = 'forged-catalog';
    },
    (body: any) => {
      body.pricing.rates.input = 'free';
    },
    (body: any) => {
      body.source.catalogUpdatedAt = '2026-02-30T00:00:00.000Z';
    },
  ]) {
    const bad = structuredClone(archive);
    const row = bad.tables.provider_settings.find((r: any) => r.kind === 'model')!;
    const body = JSON.parse(row.body);
    mutate(body);
    row.body = JSON.stringify(body);
    const empty = database();
    expect(() => empty.product.import(bad)).toThrow();
    expect(count(empty)).toBe(0);
  }
  const optionalMetadata = structuredClone(archive);
  for (const row of optionalMetadata.tables.provider_settings) {
    const body = JSON.parse(row.body);
    delete body.source;
    delete body.enabled;
    delete body.pricing;
    delete body.catalogUpdatedAt;
    if (row.kind === 'connection') body.enabled = true;
    row.body = JSON.stringify(body);
  }
  const minimalStore = database();
  minimalStore.product.import(optionalMetadata);
  expect(minimalStore.product.get('model', m.id)).not.toHaveProperty('enabled');
});

test('readiness reveals only presence and approved origin without authenticating', () => {
  const s = database();
  const c = s.product.connection(connectionBody()) as Connection;
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
  expect(readiness(s.product, c, [])).toEqual({
    enabled: true,
    originApproved: false,
    credentialStatus: 'not-required',
    catalogKind: 'remote',
  });
  vi.stubEnv('My_Gateway_Token', 'TOP_SECRET');
  const withKey = { ...c, credentialEnv: 'My_Gateway_Token' };
  const ready = readiness(s.product, withKey, ['http://127.0.0.1:9999']);
  expect(ready.credentialStatus).toBe('configured');
  expect(JSON.stringify(ready)).not.toContain('TOP_SECRET');
  vi.stubEnv('My_Gateway_Token', 'bad\r\nvalue');
  expect(readiness(s.product, withKey, []).credentialStatus).toBe('missing');
  vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', s.path);
  expect(readiness(s.product, { ...c, protocol: 'vertex-gemini-v1' }, [])).toMatchObject({
    credentialStatus: 'adc-configured',
    catalogKind: 'local-support',
  });
  expect(
    readiness(
      s.product,
      { ...c, protocol: 'vertex-gemini-v1', credentialEnv: 'GOOGLE_APPLICATION_CREDENTIALS' },
      []
    )
  ).toMatchObject({ credentialStatus: 'adc-configured', catalogKind: 'local-support' });
  vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', s.path + '.absent');
  expect(readiness(s.product, { ...c, protocol: 'vertex-gemini-v1' }, []).credentialStatus).toBe(
    'adc-unchecked'
  );
  expect(
    readiness(
      s.product,
      { ...c, protocol: 'vertex-gemini-v1', credentialEnv: 'GOOGLE_APPLICATION_CREDENTIALS' },
      []
    ).credentialStatus
  ).toBe('adc-unchecked');
  expect(network).not.toHaveBeenCalled();
});

test('impact counts current profile model IDs after settings edits and exposes metadata only', () => {
  const s = database();
  const p = s.product;
  const chat = createFixtureChat(s, 'Reference title');
  const c = p.connection(connectionBody()) as Connection;
  const m = p.model(modelBody(c)) as ModelPreset;
  const profile = p.profile(chat.id);
  const { chatId: _chatId, revision: _revision, ...body } = profile;
  updateTestProfile(p, chat.id, {
    ...body,
    expectedRevision: profile.revision,
    routes: { ...profile.routes, main: ref(m), translation: ref(m) },
  });
  s.story.saveConfig(chat.id, {
    expectedRevision: 0,
    module: null,
    stateModel: ref(m),
  });
  s.story.saveConfig(chat.id, {
    expectedRevision: 1,
    module: null,
    stateModel: ref(m),
  });
  p.model(modelBody(c, { expectedRevision: m.revision, enabled: false }), m.id);
  const impact = managementImpact(p, 'connection', c.id);
  expect(impact).toMatchObject({
    profileCount: 1,
    storyProfileCount: 1,
    modelCount: 1,
    profiles: [{ chatId: chat.id, title: chat.title, roles: ['main', 'translation'] }],
    storyProfiles: [{ chatId: chat.id, title: chat.title, roles: ['state'] }],
  });
  expect(managementImpact(p, 'model', m.id)).not.toHaveProperty('archivedRevisionCount');
  expect(Object.keys(impact.profiles[0]).sort()).toEqual(['chatId', 'roles', 'title']);
});
