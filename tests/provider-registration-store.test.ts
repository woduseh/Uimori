import { updateTestProfile } from './fixtures/model-workspace.js';
import { createFixtureChat } from './fixtures/chat.js';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import {
  RegistrationStore,
  normalizeRegistrationPlan,
  validateRegistrationArchive,
  validateRegistrationGraph,
} from '../server/provider-registration-store.js';
import type { Connection, ModelPreset } from '../core/product.js';
import type { ProviderResult, WireRecord } from '../core/transport.js';
import type { RegistrationPlan } from '../core/provider-registration.js';

const owned: { directory: string; store: Store | null }[] = [];
const database = () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-registration-'));
  const store = new Store(join(directory, 'story.sqlite'));
  const item = { directory, store: store as Store | null };
  owned.push(item);
  return { store, item };
};
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('Provider requests forbidden in store tests')
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const { directory, store } of owned.splice(0).reverse()) {
    store?.close();
    const target = resolve(directory),
      within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-registration-')
    )
      throw new Error('Unsafe test cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const reference = ({ id, revision }: { id: string; revision: number }) => ({ id, revision });
const endpoint =
  'https://aiplatform.googleapis.com/v1/projects/synthetic-registration/locations/global/publishers/google/models';
const connectionBody = (vertex = false) => ({
  title: 'Synthetic assistant connection',
  protocol: vertex ? 'vertex-gemini-v1' : 'openai-chat-v1',
  endpoint: vertex ? endpoint : 'http://127.0.0.1:9999/v1',
  credentialEnv: 'NARRATIVE_PROVIDER_REGISTRATION_SYNTHETIC',
  enabled: true,
});
const modelBody = {
  title: 'Proposed synthetic model',
  modelId: 'synthetic-proposed',
  maxOutputTokens: 1000,
  temperature: null,
};
const proposal = (): RegistrationPlan => ({
  connection: {
    kind: 'new',
    draft: {
      title: 'Disabled proposal',
      protocol: 'openai-chat-v1',
      endpoint: 'http://127.0.0.1:9998/v1',
      enabled: false,
      credentialEnv: 'NARRATIVE_PROVIDER_PROPOSED',
    },
  },
  model: { ...modelBody },
});
function setup(vertex = false) {
  const { store, item } = database();
  const connection = store.product.connection(connectionBody(vertex)) as Connection;
  const model = store.product.model({
    ...modelBody,
    modelId: vertex ? 'gemini-3.8-flash' : 'synthetic-assistant',
    connectionId: connection.id,
  }) as ModelPreset;
  const journal = new RegistrationStore(store.product);
  const input = {
    key: randomUUID(),
    request: 'Prepare a synthetic disabled model connection.',
    target: reference(model),
  };
  return { store, item, connection, model, journal, input };
}
function wire(c: Connection, m: ModelPreset): WireRecord {
  return {
    connectionId: c.id,
    protocol: c.protocol,
    role: 'main',
    modelId: m.modelId,
    method: 'POST',
    url:
      c.protocol === 'vertex-gemini-v1'
        ? `${c.endpoint}/${m.modelId}:streamGenerateContent?alt=sse`
        : `${c.endpoint}/chat/completions`,
    headers: { authorization: '[REDACTED]' },
    body: { input: 'Synthetic configuration metadata' },
    bodySha256: digest('body'),
    stablePrefixSha256: digest('prefix'),
  };
}
const result = (status: ProviderResult['status'] = 'completed'): ProviderResult => ({
  status,
  text: 'NOT_STORED_RESPONSE',
  toolCalls: [],
  refusal: null,
  error: null,
  opaqueState: { private: 'NOT_STORED_OPAQUE' },
  usage: {
    inputTokens: 100,
    outputTokens: 20,
    costUsd: null,
    raw: { private: 'NOT_STORED_RAW_USAGE' },
    priceRevision: null,
  },
});
function ready(s: ReturnType<typeof setup>, plan: RegistrationPlan = proposal()) {
  const run = s.journal.create(s.input).run;
  const attempt = s.journal.startAttempt(run.id, wire(s.connection, s.model));
  s.journal.finishAttempt(run.id, attempt, result());
  return s.journal.finish(run.id, 'ready', plan);
}
const counts = (s: Store) => ({
  connections: s.product.all('connection').length,
  models: s.product.all('model').length,
});

test('prepare and ready are proposal only; hash/revision CAS apply is atomic and idempotent', () => {
  const s = setup();
  const before = counts(s.store);
  const versions = Number(
    (s.store.db.prepare('SELECT COUNT(*) AS n FROM versions').get() as { n: number }).n
  );
  const normalized = normalizeRegistrationPlan(s.store.product, proposal());
  expect(normalized).toEqual(proposal());
  expect(
    Number((s.store.db.prepare('SELECT COUNT(*) AS n FROM versions').get() as { n: number }).n)
  ).toBe(versions);
  const run = ready(s);
  expect(
    s.store.db
      .prepare("SELECT COUNT(*) AS n FROM versions WHERE kind='registration-run' AND id=?")
      .get(run.id)
  ).toMatchObject({ n: 1 });
  expect(() => s.store.product.get('registration-run', run.id, run.revision - 1)).toThrow();
  expect(counts(s.store)).toEqual(before);
  expect(s.journal.view(run.id).usage?.costUsd).toBeNull();
  for (const body of [
    { expectedRevision: run.revision - 1, planHash: run.planHash },
    { expectedRevision: run.revision, planHash: 'a'.repeat(64) },
  ])
    expect(() => s.journal.apply(run.id, body)).toThrow('Registration proposal changed');
  expect(counts(s.store)).toEqual(before);
  const applied = s.journal.apply(run.id, {
    expectedRevision: run.revision,
    planHash: run.planHash,
  });
  expect(applied.status).toBe('applied');
  expect(
    s.store.db
      .prepare("SELECT COUNT(*) AS n FROM versions WHERE kind='registration-run' AND id=?")
      .get(run.id)
  ).toMatchObject({ n: 1 });
  expect(applied.attempts).toEqual(run.attempts);
  expect(applied.targetSnapshot).toEqual(run.targetSnapshot);
  expect(applied.plan).toEqual(run.plan);
  expect(applied.planConnectionSnapshot).toEqual(run.planConnectionSnapshot);
  expect(counts(s.store)).toEqual({
    connections: before.connections + 1,
    models: before.models + 1,
  });
  const c = s.store.product.get<Connection>('connection', applied.applied!.connection.id),
    m = s.store.product.get<ModelPreset>('model', applied.applied!.model.id);
  expect(c.enabled).toBe(false);
  expect(m.connectionId).toBe(c.id);
  expect(
    s.journal.apply(run.id, { expectedRevision: run.revision, planHash: run.planHash })
  ).toEqual(applied);
  expect(counts(s.store)).toEqual({
    connections: before.connections + 1,
    models: before.models + 1,
  });
  validateRegistrationGraph(s.store.product);
});

test('apply rolls back new connection/model inserts when the current registration receipt update fails', () => {
  const s = setup(),
    run = ready(s),
    before = counts(s.store);
  s.store.db.exec(
    "CREATE TRIGGER fail_registration_apply BEFORE UPDATE ON versions WHEN NEW.kind='registration-run' AND json_extract(NEW.body,'$.status')='applied' BEGIN SELECT RAISE(ABORT,'Synthetic final-write failure'); END;"
  );
  expect(() =>
    s.journal.apply(run.id, { expectedRevision: run.revision, planHash: run.planHash })
  ).toThrow('Synthetic final-write failure');
  expect(counts(s.store)).toEqual(before);
  expect(s.journal.get(run.id)).toEqual(run);
});

test('existing connection edits make apply stale, while archived historical plans remain valid', () => {
  const s = setup();
  const plan: RegistrationPlan = {
    connection: { kind: 'existing', ...reference(s.connection) },
    model: { ...modelBody },
  };
  const run = ready(s, plan);
  s.store.product.connection(
    { ...connectionBody(), title: 'Renamed after review', expectedRevision: s.connection.revision },
    s.connection.id
  );
  const before = counts(s.store);
  expect(() =>
    s.journal.apply(run.id, { expectedRevision: run.revision, planHash: run.planHash })
  ).toThrow('Connection changed');
  expect(counts(s.store)).toEqual(before);
  expect(() => validateRegistrationGraph(s.store.product)).not.toThrow();
  const restored = database().store;
  restored.product.import(s.store.product.export());
  expect(new RegistrationStore(restored.product).get(run.id).plan).toEqual(plan);
});

test('known model proposals validate against the reviewed connection without storing capability metadata in the proposal', () => {
  const s = setup(true);
  const plan: RegistrationPlan = {
    connection: { kind: 'existing', ...reference(s.connection) },
    model: { ...modelBody, modelId: 'gemini-3.8-flash', timeoutMs: 240000 },
  };
  const reviewed = ready(s, plan);
  expect(reviewed.plan!.model).not.toHaveProperty('capabilityRevision');
  expect(() => validateRegistrationArchive(reviewed)).not.toThrow();
  expect(() => validateRegistrationGraph(s.store.product)).not.toThrow();
  const applied = s.journal.apply(reviewed.id, {
    expectedRevision: reviewed.revision,
    planHash: reviewed.planHash,
  });
  expect(applied.appliedSnapshot!.model.capabilityRevision).toBe(s.model.capabilityRevision);
  expect(() => validateRegistrationGraph(s.store.product)).not.toThrow();
});

test('untrusted protocol/options/credential values/overrides cannot become proposals or settings', () => {
  const s = setup();
  const before = counts(s.store);
  const attacks: ((p: any) => void)[] = [
    (p) => (p.connection.draft.protocol = 'unsupported'),
    (p) => (p.connection.draft.enabled = true),
    (p) => (p.connection.draft.credentialEnv = 'sk-SYNTHETIC_RAW_KEY_VALUE'),
    (p) => (p.connection.draft.apiKey = 'raw'),
    (p) => (p.connection.draft.endpoint = 'http://127.0.0.1:9998/v1?api_key=raw'),
    (p) => (p.model.thinkingMode = 'enabled'),
    (p) => (p.model.userOverrides = { tools: true, structuredOutput: true, note: 'model claims' }),
    (p) => (p.model.temperature = '1'),
  ];
  for (const mutate of attacks) {
    const value = proposal();
    mutate(value);
    expect(() => normalizeRegistrationPlan(s.store.product, value)).toThrow();
    expect(counts(s.store)).toEqual(before);
  }
  vi.stubEnv(s.connection.credentialEnv!, 'EXACT_SYNTHETIC_SECRET');
  expect(() => s.journal.create({ ...s.input, request: 'Use EXACT_SYNTHETIC_SECRET' })).toThrow(
    'Do not include credentials'
  );
  expect(() => s.journal.create({ ...s.input, request: 'Use sk-SYNTHETIC_RAW_KEY_VALUE' })).toThrow(
    'Do not include credentials'
  );
  expect(s.store.product.all('registration-run')).toEqual([]);
});

test('same key returns the same durable run without another attempt; crash reopening never replays', () => {
  const s = setup();
  const first = s.journal.create(s.input);
  const id = s.journal.startAttempt(first.run.id, wire(s.connection, s.model));
  expect(s.journal.create(s.input).created).toBe(false);
  expect(s.journal.get(first.run.id).attempts).toHaveLength(1);
  expect(() => s.journal.startAttempt(first.run.id, wire(s.connection, s.model))).toThrow(
    'no longer admitted'
  );
  expect(() => s.journal.create({ ...s.input, request: 'Changed intent' })).toThrow(
    'different input'
  );
  const path = s.store.path;
  s.store.close();
  s.item.store = null;
  const reopened = new Store(path);
  s.item.store = reopened;
  const journal = new RegistrationStore(reopened.product);
  journal.recover();
  const recovered = journal.get(first.run.id);
  expect(
    reopened.db
      .prepare("SELECT COUNT(*) AS n FROM versions WHERE kind='registration-run' AND id=?")
      .get(first.run.id)
  ).toMatchObject({ n: 1 });
  expect(recovered).toMatchObject({
    status: 'interrupted',
    error: 'SERVER_INTERRUPTED_NO_AUTOMATIC_REPLAY',
    attempts: [{ id, status: 'running', usage: null }],
  });
  expect(journal.create(s.input).created).toBe(false);
  expect(journal.byKey(s.input.key).status).toBe('interrupted');
  const revision = recovered.revision;
  journal.recover();
  expect(journal.get(recovered.id).revision).toBe(revision);
  validateRegistrationGraph(reopened.product);
});

test('JSON and SQLite backup roundtrip retain null accounting without raw response, key or continuation', () => {
  const s = setup();
  vi.stubEnv(s.connection.credentialEnv!, 'SYNTHETIC_SECRET_NOT_IN_ARCHIVE');
  const run = ready(s);
  s.journal.apply(run.id, { expectedRevision: run.revision, planHash: run.planHash });
  const archive = s.store.product.export();
  const serialized = JSON.stringify(archive);
  for (const marker of [
    'NOT_STORED_RESPONSE',
    'NOT_STORED_OPAQUE',
    'NOT_STORED_RAW_USAGE',
    'SYNTHETIC_SECRET_NOT_IN_ARCHIVE',
  ])
    expect(serialized).not.toContain(marker);
  const restored = database().store;
  restored.product.import(archive);
  const imported = new RegistrationStore(restored.product).view(run.id);
  expect(imported.status).toBe('applied');
  expect(imported.usage).toMatchObject({ costUsd: null, raw: null, priceRevision: null });
  expect(restored.product.get('connection', s.connection.id)).not.toHaveProperty('credentialEnv');
  const bytes = s.store.product.backup();
  const target = database();
  const path = target.store.path;
  target.store.close();
  target.item.store = null;
  writeFileSync(path, bytes);
  target.item.store = new Store(path);
  expect(new RegistrationStore(target.item.store.product).view(run.id)).toEqual(
    s.journal.view(run.id)
  );
  validateRegistrationGraph(target.item.store.product);
});

test('archive schemas and graph reject poisoned plans, applied refs, fractional tokens and dropped attempts', () => {
  const s = setup();
  const run = ready(s);
  const applied = s.journal.apply(run.id, {
    expectedRevision: run.revision,
    planHash: run.planHash,
  });
  const valid = s.store.product.export();
  const attacks: ((r: any) => void)[] = [
    (r) => (r.applied = null),
    (r) => (r.applied.model = { id: 'missing', revision: 1 }),
    (r) => (r.plan.model.maxOutputTokens = 'many'),
    (r) => (r.plan.model.userOverrides = { tools: true, structuredOutput: true, note: '' }),
    (r) => (r.attempts[0].usage.inputTokens = 1.5),
    (r) => (r.attempts = []),
    (r) => (r.attempts[0].request.modelId = 'different'),
    (r) => (r.attempts[0].request.headers.authorization = 'Bearer RAW_SECRET'),
    (r) => (r.attempts[0].request.body.opaqueState = { raw: 'private' }),
    (r) => (r.finishedAt = 'not-a-date'),
  ];
  for (const mutate of attacks) {
    const archive = structuredClone(valid);
    const row = archive.tables.versions.find(
      (row: any) => row.id === applied.id && row.revision === applied.revision
    )!;
    const body = JSON.parse(row.body);
    mutate(body);
    if (body.plan) body.planHash = digest(body.plan);
    row.body = JSON.stringify(body);
    const target = database().store;
    expect(() => target.product.import(archive)).toThrow();
    expect(target.product.all('connection')).toEqual([]);
  }
  const malformed = structuredClone(applied);
  malformed.status = 'running';
  expect(() => validateRegistrationArchive(malformed)).toThrow();
});

test('registration retains its per-run attempt limit and durable usage across independent runs and archive restore', () => {
  const s = setup(true);
  const run = s.journal.create(s.input).run;
  const request = wire(s.connection, s.model);
  const attempt = s.journal.startAttempt(run.id, request);
  expect(s.journal.get(run.id).attempts).toEqual([
    { id: attempt, request, status: 'running', usage: null, error: null },
  ]);
  expect(() => s.journal.startAttempt(run.id, request)).toThrow(
    'Registration request is no longer admitted'
  );
  s.journal.finishAttempt(run.id, attempt, result());
  s.journal.finish(run.id, 'ready', proposal());
  expect(s.journal.view(run.id)).toMatchObject({
    modelCalls: 1,
    usage: { inputTokens: 100, outputTokens: 20, costUsd: null, raw: null, priceRevision: null },
  });
  const other = s.journal.create({ ...s.input, key: randomUUID() }).run;
  const otherAttempt = s.journal.startAttempt(other.id, request);
  s.journal.finishAttempt(other.id, otherAttempt, result());
  s.journal.finish(other.id, 'ready', proposal());
  const restored = database().store;
  restored.product.import(s.store.product.export());
  expect(new RegistrationStore(restored.product).view(run.id)).toEqual(s.journal.view(run.id));
  expect(new RegistrationStore(restored.product).view(other.id)).toEqual(s.journal.view(other.id));
  for (const id of [run.id, other.id])
    expect(new RegistrationStore(restored.product).get(id).targetSnapshot.connection).toMatchObject(
      { id: s.connection.id, enabled: false }
    );
});

test('edits replace current settings while registration replay and applied snapshots remain frozen', () => {
  const s = setup();
  const plan: RegistrationPlan = {
    connection: { kind: 'existing', ...reference(s.connection) },
    model: { ...modelBody },
  };
  const reviewed = ready(s, plan);
  const applied = s.journal.apply(reviewed.id, {
    expectedRevision: reviewed.revision,
    planHash: reviewed.planHash,
  });
  const frozen = structuredClone(applied),
    created = applied.appliedSnapshot!.model;
  const updatedTarget = s.store.product.model(
    {
      ...modelBody,
      title: 'Changed assistant',
      modelId: 'changed-assistant',
      connectionId: s.connection.id,
      expectedRevision: s.model.revision,
    },
    s.model.id
  ) as ModelPreset;
  s.store.product.model(
    {
      ...modelBody,
      title: 'Changed applied model',
      modelId: 'changed-applied',
      connectionId: s.connection.id,
      expectedRevision: created.revision,
    },
    created.id
  );
  s.store.product.connection(
    {
      ...connectionBody(),
      title: 'Changed connection',
      endpoint: 'http://127.0.0.1:9988/v1',
      expectedRevision: s.connection.revision,
    },
    s.connection.id
  );
  expect(() => s.store.product.get('model', s.model.id, s.model.revision)).toThrow(
    'Setting not found'
  );
  expect(() => s.store.product.get('connection', s.connection.id, s.connection.revision)).toThrow(
    'Setting not found'
  );
  expect(s.journal.create(s.input)).toMatchObject({
    created: false,
    run: frozen,
    target: frozen.targetSnapshot,
  });
  expect(
    s.journal.apply(reviewed.id, {
      expectedRevision: reviewed.revision,
      planHash: reviewed.planHash,
    })
  ).toEqual(frozen);
  expect(() => s.journal.create({ ...s.input, key: randomUUID() })).toThrow('model changed');
  expect(
    s.store.db
      .prepare("SELECT COUNT(*) AS n FROM versions WHERE kind IN ('connection','model')")
      .get()
  ).toMatchObject({ n: 0 });
  expect(s.store.product.get<ModelPreset>('model', s.model.id)).toEqual(updatedTarget);
  expect(() => validateRegistrationGraph(s.store.product)).not.toThrow();
  const restored = database().store;
  restored.product.import(s.store.product.export());
  const journal = new RegistrationStore(restored.product);
  expect(journal.view(reviewed.id)).toEqual(s.journal.view(reviewed.id));
  const receipt = journal.get(reviewed.id);
  expect(receipt.targetSnapshot.modelId).toBe(s.model.modelId);
  expect(receipt.appliedSnapshot!.model.modelId).toBe(created.modelId);
  for (const connection of [
    receipt.targetSnapshot.connection,
    receipt.planConnectionSnapshot,
    receipt.appliedSnapshot!.connection,
  ]) {
    expect(connection).not.toHaveProperty('credentialEnv');
    expect(connection?.enabled).toBe(false);
  }
  expect(() => validateRegistrationGraph(restored.product)).not.toThrow();
});

test('registration prepare/apply does not assign roles or modify a source and frozen run', () => {
  const s = setup();
  const chat = createFixtureChat(s.store, 'Synthetic role owner');
  const p = s.store.product.profile(chat.id);
  updateTestProfile(s.store.product, chat.id, {
    expectedRevision: p.revision,
    attachments: [],

    routes: { ...p.routes, main: { id: s.model.id } },
    image: false,
  });
  const profile = s.store.product.snapshot(chat.id)!;
  const run = s.store.createRun(
    chat.id,
    {
      request: 'Synthetic story',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current) => ({
      chatId: chat.id,
      parentRevision: null,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request: 'Synthetic story',
      history: [],
      resources: [],
      profile,
    })
  ).run;
  s.store.startRun(run.id);
  const source = s.store.completeRun(
    run.id,
    'An immutable synthetic scene.',
    { modelCalls: 1, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
  const before = {
    profile: s.store.product.profile(chat.id),
    snapshot: s.store.run(run.id).snapshot,
    source: s.store.source(source.id),
    story: s.store.story.config(chat.id),
  };
  const registration = ready(s);
  s.journal.apply(registration.id, {
    expectedRevision: registration.revision,
    planHash: registration.planHash,
  });
  expect({
    profile: s.store.product.profile(chat.id),
    snapshot: s.store.run(run.id).snapshot,
    source: s.store.source(source.id),
    story: s.store.story.config(chat.id),
  }).toEqual(before);
});

test('fixture root endpoints compare the normalized transport URL during archive validation', () => {
  const s = setup();
  const c = s.store.product.connection({
    title: 'Root fixture',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9997',
    enabled: true,
  }) as Connection;
  const m = s.store.product.model({ ...modelBody, connectionId: c.id }) as ModelPreset;
  const run = s.journal.create({ ...s.input, key: randomUUID(), target: reference(m) }).run;
  const attempt = s.journal.startAttempt(run.id, { ...wire(c, m), url: new URL(c.endpoint).href });
  s.journal.finishAttempt(run.id, attempt, result());
  s.journal.finish(run.id, 'ready', proposal());
  expect(() => validateRegistrationGraph(s.store.product)).not.toThrow();
  const restored = database().store;
  expect(() => restored.product.import(s.store.product.export())).not.toThrow();
});
