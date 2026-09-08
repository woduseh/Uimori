import { updateTestProfile } from './fixtures/model-workspace.js';
import { createFixtureChat } from './fixtures/chat.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { assertModelSelection } from '../server/provider-selection.js';
import { isModelSelectable } from '../web/model-selection.js';
import { defaultStoryConfig } from '../core/story.js';
import type { Connection, ModelRef, ModelPreset } from '../core/product.js';

const owned: { directory: string; store: Store }[] = [];
const database = () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-selection-'));
  const store = new Store(join(directory, 'story.sqlite'));
  owned.push({ directory, store });
  return store;
};
afterEach(() => {
  for (const { directory, store } of owned.splice(0).reverse()) {
    store.close();
    const target = resolve(directory),
      within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-selection-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});
const ref = ({ id }: ModelRef) => ({ id });
const connectionBody = (extra: Record<string, unknown> = {}) => ({
  title: 'Connection',
  protocol: 'openai-chat-v1',
  endpoint: 'http://127.0.0.1:9999/v1',
  enabled: true,
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
function setup() {
  const s = database(),
    chat = createFixtureChat(s, 'Synthetic');
  const c = s.product.connection(connectionBody()) as Connection,
    m = s.product.model(modelBody(c)) as ModelPreset;
  return { s, chat, c, m };
}
function assign(s: Store, chatId: string, routes: Record<string, ModelRef | null>) {
  const p = s.product.profile(chatId);
  return updateTestProfile(s.product, chatId, {
    expectedRevision: p.revision,
    attachments: p.attachments,

    image: p.image,
    routes: { ...p.routes, ...routes },
  });
}

test('disabled models retain assigned IDs but block new assignments and new snapshots while completed runs stay immutable', () => {
  const { s, chat, c, m } = setup();
  assign(s, chat.id, { main: ref(m) });
  const profile = s.product.snapshot(chat.id)!;
  const run = s.createRun(
    chat.id,
    {
      request: 'Synthetic request',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current) => ({
      chatId: chat.id,
      parentRevision: null,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request: 'Synthetic request',
      history: [],
      resources: [],
      profile,
    })
  ).run;
  s.startRun(run.id);
  const source = s.completeRun(
    run.id,
    'Synthetic immutable original',
    { modelCalls: 1, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
  const snapshot = s.run(run.id).snapshot,
    original = s.source(source.id);
  const disabled = s.product.model(
    modelBody(c, { expectedRevision: m.revision, enabled: false }),
    m.id
  ) as ModelPreset;
  expect(() => assertModelSelection(s.product, ref(m))).toThrow('비활성');
  expect(() => assign(s, chat.id, { translation: ref(m) })).toThrow('비활성');
  expect(() => s.product.snapshot(chat.id)).toThrow('Model disabled');
  expect(assign(s, chat.id, { main: ref(m) }).routes.main).toEqual(ref(m));
  expect(s.source(source.id)).toEqual(original);
  expect(s.run(run.id).snapshot).toEqual(snapshot);
  expect(s.product.get('model', m.id)).toEqual(disabled);
  expect(() => s.product.get('model', m.id, m.revision)).toThrow('Setting not found');
  s.product.model(modelBody(c, { expectedRevision: disabled.revision }), m.id);
  expect(() => assign(s, chat.id, { translation: ref(m) })).not.toThrow();
});

test('ID-based selections follow current connections while protocol changes require a model review before execution', () => {
  for (const change of [
    { title: 'Renamed' },
    { endpoint: 'http://127.0.0.1:9998/v1' },
    { credentialEnv: 'NARRATIVE_PROVIDER_DIFFERENT' },
    { protocol: 'fixture-sse-v1', endpoint: 'http://127.0.0.1:9999/v1' },
  ]) {
    const { s, chat, c, m } = setup();
    assign(s, chat.id, { main: ref(m) });
    const latest = s.product.connection(
      connectionBody({ expectedRevision: c.revision, ...change }),
      c.id
    ) as Connection;
    expect(assign(s, chat.id, { translation: ref(m) }).routes).toMatchObject({
      main: ref(m),
      translation: ref(m),
    });
    expect(isModelSelectable(m, [m], [latest])).toBe(true);
    expect(s.product.get('model', m.id)).toEqual(m);
    if ('protocol' in change) {
      expect(() => s.product.modelSnapshot(m.id)).toThrow('Connection protocol changed');
      const reviewed = s.product.model(
        modelBody(latest, { expectedRevision: m.revision }),
        m.id
      ) as ModelPreset;
      expect(reviewed.capabilityProtocol).toBe(latest.protocol);
      expect(s.product.modelSnapshot(m.id).connection).toEqual(latest);
    } else expect(s.product.modelSnapshot(m.id).connection).toEqual(latest);
  }
  const { s, chat, c, m } = setup();
  assign(s, chat.id, { main: ref(m) });
  const disabled = s.product.connection(
    connectionBody({ enabled: false, expectedRevision: c.revision }),
    c.id
  ) as Connection;
  expect(isModelSelectable(m, [m], [disabled])).toBe(false);
  expect(() => assign(s, chat.id, { translation: ref(m) })).toThrow('연결');
  expect(assign(s, chat.id, { main: ref(m) }).routes.main).toEqual(ref(m));
  expect(() => s.product.snapshot(chat.id)).toThrow('Connection disabled');
  const vertex = s.product.connection(
    connectionBody({
      protocol: 'vertex-gemini-v1',
      endpoint:
        'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models',
    })
  ) as Connection;
  const vm = s.product.model(modelBody(vertex, { modelId: 'gemini-3.8-flash' })) as ModelPreset;
  const flex = s.product.model(
    modelBody(vertex, {
      modelId: 'gemini-3.8-flash',
      serviceTier: 'flex',
      expectedRevision: vm.revision,
    }),
    vm.id
  ) as ModelPreset;
  expect(() => assertModelSelection(s.product, ref(vm))).not.toThrow();
  expect(isModelSelectable(vm, [flex], [vertex])).toBe(true);
});

test('state and memory retain selected IDs while rejecting a disabled model newly assigned to another role', () => {
  const { s, chat, c, m } = setup();
  const defaults = defaultStoryConfig();
  s.story.saveConfig(chat.id, {
    expectedRevision: 0,
    module: null,
    stateModel: ref(m),
    memory: defaults.memory,
  });
  s.product.model(modelBody(c, { expectedRevision: m.revision, enabled: false }), m.id);
  expect(() =>
    s.story.saveConfig(chat.id, {
      expectedRevision: 1,
      module: null,
      stateModel: ref(m),
      memory: { ...defaults.memory, model: ref(m) },
    })
  ).toThrow('비활성');
  const saved = s.story.saveConfig(chat.id, {
    expectedRevision: 1,
    module: null,
    stateModel: ref(m),
    memory: { ...defaults.memory, recentCount: 3 },
  });
  expect(saved.stateModel).toEqual(ref(m));
  expect(saved.memory.recentCount).toBe(3);
  const other = createFixtureChat(s, 'Other');
  expect(() =>
    s.story.saveConfig(other.id, {
      expectedRevision: 0,
      module: null,
      stateModel: ref(m),
      memory: defaults.memory,
    })
  ).toThrow('비활성');
});

test('model draft validation uses explicit matching unsaved connection without any DB writes', () => {
  const s = database();
  const prepared = s.product.prepareConnection(connectionBody());
  const draft = { ...prepared.value, id: 'unpersisted', revision: 1 };
  expect(s.product.prepareModel(modelBody(draft), undefined, draft).value.source).toEqual({
    kind: 'manual',
    catalogUpdatedAt: null,
  });
  expect(() =>
    s.product.prepareModel(modelBody(draft, { connectionRevision: 2 }), undefined, draft)
  ).toThrow();
  expect(() =>
    s.product.prepareModel(modelBody(draft, { connectionId: 'another' }), undefined, draft)
  ).toThrow('Validation connection mismatch');
  expect(() =>
    s.product.prepareModel(modelBody(draft, { thinkingMode: 'enabled' }), undefined, draft)
  ).toThrow('UNSUPPORTED_GENERATION_OPTIONS');
  expect(s.product.all('connection')).toEqual([]);
  expect(s.product.all('model')).toEqual([]);
});

test('model snapshots are detached from current settings and selection checks use the latest connection ID', () => {
  const { s, c, m } = setup();
  const snapshot = s.product.modelSnapshot(m.id);
  const replacement = s.product.connection(
    connectionBody({ title: 'Replacement connection' })
  ) as Connection;
  const moved = s.product.model(
    modelBody(replacement, { expectedRevision: m.revision, maxOutputTokens: 2048 }),
    m.id
  ) as ModelPreset;
  const disabled = s.product.connection(
    connectionBody({ expectedRevision: c.revision, enabled: false }),
    c.id
  ) as Connection;
  expect(isModelSelectable(m, [moved], [disabled, replacement])).toBe(true);
  expect(s.product.modelSnapshot(m.id)).toMatchObject({ ...moved, connection: replacement });
  expect(snapshot).toEqual({ ...m, connection: c });
  snapshot.connection.catalog.push({
    id: 'mutated-copy',
    name: 'Not stored',
    capabilities: {},
    priceRevision: null,
  });
  snapshot.title = 'Changed copy';
  expect(s.product.get('connection', c.id)).toEqual(disabled);
  expect(s.product.get('model', m.id)).toEqual(moved);
  for (const [kind, id] of [
    ['model', m.id],
    ['connection', c.id],
  ])
    expect(
      s.db
        .prepare('SELECT COUNT(*) AS count FROM provider_settings WHERE kind=? AND id=?')
        .get(kind, id)?.count
    ).toBe(1);
  expect(
    s.db
      .prepare("SELECT COUNT(*) AS count FROM versions WHERE kind IN ('model','connection')")
      .get()?.count
  ).toBe(0);
});
