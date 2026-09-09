import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';
import {
  emptyModelRoutes,
  modelWorkspace,
  promptWorkspace,
  updateModelWorkspace,
  updatePromptWorkspace,
} from '../server/prompt-workspace.js';
import { deleteLibraryItem } from '../server/library-deletion.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';

const owned: { path: string; store: Store }[] = [];
function database() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-model-workspace-'));
  const store = new Store(join(path, 'story.sqlite'));
  owned.push({ path, store });
  return store;
}
afterEach(() => {
  for (const { path, store } of owned.splice(0)) {
    store.close();
    const within = relative(resolve(tmpdir()), resolve(path));
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-model-workspace-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function model(store: Store, title: string) {
  const connection = store.product.connection({
    title,
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  return store.product.model({
    title,
    connectionId: connection.id,
    modelId: 'fixture',
    maxOutputTokens: 1024,
    temperature: null,
  });
}
function select(store: Store, id: string) {
  const current = modelWorkspace(store);
  return updateModelWorkspace(store, {
    expectedRevision: current.revision,
    routes: { main: { id }, translation: { id }, status: { id }, image: { id } },
    translationPolicy: { refusalModel: { id }, maxRetries: 1, maxCalls: 16 },
  });
}
function complete(store: Store, chatId: string) {
  const chat = store.chat(chatId),
    profile = store.product.snapshot(chatId);
  const run = store.createRun(
    chatId,
    {
      request: 'Synthetic scene',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    () => ({
      chatId,
      parentRevision: chat.headRevision,
      settingsRevision: chat.settingsRevision,
      settings: chat.settings,
      request: 'Synthetic scene',
      history: store.history(chat.headRevision),
      resources: store.product.resources(chatId, profile),
      profile,
    })
  ).run;
  store.startRun(run.id);
  const source = store.completeRun(
    run.id,
    'Synthetic source.',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
  return { run: store.run(run.id), source };
}

test('legacy chat selections never seed global defaults and reading current settings does not migrate stored data', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Legacy chat'),
    old = model(store, 'Old');
  const workspace = promptWorkspace(store);
  const { modelRoutes: _routes, ...legacyWorkspace } = workspace;
  store.db
    .prepare('UPDATE prompt_workspace SET body=? WHERE id=1')
    .run(JSON.stringify(legacyWorkspace));
  const legacy = {
    ...store.product.profile(chat.id),
    routes: { ...emptyModelRoutes(), main: { id: old.id } },
  };
  store.db
    .prepare('UPDATE profiles SET body=? WHERE chat_id=?')
    .run(JSON.stringify(legacy), chat.id);
  const before = store.db.prepare('SELECT body FROM profiles WHERE chat_id=?').get(chat.id);
  expect(modelWorkspace(store).routes).toEqual(emptyModelRoutes());
  expect(store.product.profile(chat.id).routes).toEqual(emptyModelRoutes());
  expect(store.db.prepare('SELECT body FROM profiles WHERE chat_id=?').get(chat.id)).toEqual(
    before
  );
  expect(store.db.prepare('SELECT body FROM prompt_workspace').get()?.body).toBe(
    JSON.stringify(legacyWorkspace)
  );
  expect(() =>
    store.product.updateProfile(chat.id, {
      expectedRevision: legacy.revision,
      attachments: legacy.attachments,
      image: false,
      routes: legacy.routes,
    })
  ).toThrow(/Unknown request field/);
  const chosen = model(store, 'Chosen');
  select(store, chosen.id);
  const fresh = createFixtureChat(store, 'Another bot');
  for (const item of [chat, fresh])
    expect(store.product.snapshot(item.id).models.main?.id).toBe(chosen.id);
  expect(
    JSON.parse(
      String(store.db.prepare('SELECT body FROM profiles WHERE chat_id=?').get(fresh.id)?.body)
    )
  ).not.toHaveProperty('routes');
});

test('optional title model is independent of task routes, strict, CAS protected and preserved by omitted updates', () => {
  const store = database();
  expect(modelWorkspace(store).titleModel).toBeNull();
  const title = model(store, 'Title');
  const current = modelWorkspace(store);
  const save = (titleModel: unknown, expectedRevision = modelWorkspace(store).revision) =>
    updateModelWorkspace(store, {
      expectedRevision,
      routes: current.routes,
      translationPolicy: current.translationPolicy,
      titleModel,
    });
  const selected = save({ id: title.id });
  expect(selected.titleModel).toEqual({ id: title.id });
  expect(selected.routes).toEqual(emptyModelRoutes());
  expect(() => save(null, current.revision)).toThrow(/새로고침/);
  expect(() => save({ id: title.id, revision: 1 })).toThrow(/Unknown request field/);
  expect(() => save({ id: 'missing-title-model' })).toThrow();
  select(store, model(store, 'Main').id);
  expect(modelWorkspace(store).titleModel).toEqual({ id: title.id });
  updatePromptWorkspace(store, { expectedRevision: modelWorkspace(store).revision });
  expect(promptWorkspace(store).titleModel).toEqual({ id: title.id });
  expect(save(null).titleModel).toBeNull();
});

test('current global selection is shared, CAS protected and frozen in prior Runs and reservations', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Shared'),
    a = model(store, 'A'),
    b = model(store, 'B');
  const firstSettings = select(store, a.id),
    first = complete(store, chat.id);
  const translation = store.requestTranslation(first.source.id),
    frozen = structuredClone(translation);
  const secondSettings = select(store, b.id);
  expect(() =>
    updateModelWorkspace(store, {
      expectedRevision: firstSettings.revision,
      routes: firstSettings.routes,
      translationPolicy: firstSettings.translationPolicy,
    })
  ).toThrow(/새로고침/);
  expect(store.run(first.run.id)).toEqual(first.run);
  expect(store.job(translation.id)).toEqual(frozen);
  expect(store.requestTranslation(first.source.id).id).toBe(translation.id);
  expect(store.product.snapshot(chat.id).models.main?.id).toBe(b.id);
  store.cancelJob(translation.id);
  const cancelled = store.job(translation.id);
  const retried = store.retryJob(translation.id);
  expect(retried.id).not.toBe(translation.id);
  expect(retried.input).toMatchObject({
    translationModelSelection: { id: b.id },
    promptWorkspaceRevision: secondSettings.revision,
  });
  expect(store.job(translation.id)).toEqual(cancelled);
  expect(
    store.product.resolveJobPrompt(first.run.snapshot, frozen.input).profile?.models.translation?.id
  ).toBe(a.id);
  store.cancelJob(retried.id);
  const manual = store.retranslate(first.source.id);
  expect(manual.input).toMatchObject({ translationModelSelection: { id: b.id } });
});

test('status retry retains its reservation while a new explicit status request uses current global models', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Status'),
    a = model(store, 'A'),
    b = model(store, 'B');
  select(store, a.id);
  const first = complete(store, chat.id);
  const status = store.requestStatus(first.source.id, first.source.hash, null);
  store.cancelJob(status.id);
  select(store, b.id);
  expect(store.retryJob(status.id).input).toEqual(status.input);
  expect(
    store.product.resolveJobPrompt(first.run.snapshot, status.input).profile?.models.status?.id
  ).toBe(a.id);
  store.cancelJob(status.id);
  const next = store.requestStatus(first.source.id, first.source.hash, status.id);
  expect(next.input).toMatchObject({ statusModelSelection: { id: b.id } });
});

test('disabled and deleted selections block new work without rewriting historical snapshots or selecting substitutes', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Revocation'),
    a = model(store, 'A');
  select(store, a.id);
  const frozen = store.product.snapshot(chat.id);
  store.db
    .prepare(
      "UPDATE provider_settings SET body=json_set(body,'$.enabled',json('false')) WHERE kind='connection' AND id=?"
    )
    .run(a.connectionId);
  expect(() => store.product.snapshot(chat.id)).toThrow();
  expect(modelWorkspace(store).routes.main).toEqual({ id: a.id });
  const connection = store.product.get<{ revision: number }>('connection', a.connectionId);
  deleteLibraryItem(store, 'connection', a.connectionId, { expectedRevision: connection.revision });
  expect(modelWorkspace(store).routes).toEqual(emptyModelRoutes());
  expect(modelWorkspace(store).translationPolicy.refusalModel).toBeNull();
  expect(frozen.models.main?.id).toBe(a.id);
  expect(frozen.models.main?.connection.enabled).toBe(true);
});

test('archive preserves global routes and immutable execution settings; absent legacy global routes stay unselected', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Archive'),
    a = model(store, 'A');
  select(store, a.id);
  const first = complete(store, chat.id);
  updatePromptWorkspace(store, {
    expectedRevision: promptWorkspace(store).revision,
    main: { title: 'Later', program: createDefaultPromptProgram('Later'), values: {} },
  });
  const archive = store.product.export(),
    restored = database();
  restored.product.import(archive);
  expect(modelWorkspace(restored)).toEqual(modelWorkspace(store));
  // Archive import intentionally revokes copied connection authority, including frozen copies.
  const archivedSnapshot = structuredClone(first.run.snapshot);
  for (const target of Object.values(archivedSnapshot.profile!.models))
    target!.connection.enabled = false;
  expect(restored.run(first.run.id).snapshot).toEqual(archivedSnapshot);
  const legacy = structuredClone(archive);
  const body = JSON.parse(legacy.tables.prompt_workspace[0].body);
  delete body.modelRoutes;
  legacy.tables.prompt_workspace[0].body = JSON.stringify(body);
  const old = database();
  old.product.import(legacy);
  expect(modelWorkspace(old).routes).toEqual(emptyModelRoutes());
  expect(old.run(first.run.id).snapshot).toEqual(archivedSnapshot);
});

test('archive rejects explicit null route objects atomically while legacy absent fields remain valid', () => {
  const store = database();
  createFixtureChat(store, 'Archive strict routes');
  const archive = store.product.export();
  for (const table of ['prompt_workspace', 'profiles'] as const) {
    const damaged = structuredClone(archive);
    const row = damaged.tables[table][0];
    const body = JSON.parse(row.body);
    body[table === 'prompt_workspace' ? 'modelRoutes' : 'routes'] = null;
    row.body = JSON.stringify(body);
    const target = database();
    const before = target.product.export();
    expect(() => target.product.import(damaged)).toThrow('Expected an object');
    expect(target.product.export().tables).toEqual(before.tables);
  }
  const restored = database();
  const legacy = structuredClone(archive);
  for (const table of ['prompt_workspace', 'profiles'] as const) {
    const row = legacy.tables[table][0],
      body = JSON.parse(row.body);
    delete body[table === 'prompt_workspace' ? 'modelRoutes' : 'routes'];
    row.body = JSON.stringify(body);
  }
  restored.product.import(legacy);
  expect(modelWorkspace(restored).routes).toEqual(emptyModelRoutes());
  expect(restored.chats()).toHaveLength(1);
});

test('reading an explicit null global routes object rejects corruption without modifying it', () => {
  const store = database(),
    prior = promptWorkspace(store);
  const body = JSON.stringify({ ...prior, modelRoutes: null });
  store.db.prepare('UPDATE prompt_workspace SET body=? WHERE id=1').run(body);
  expect(() => modelWorkspace(store)).toThrow('Expected an object');
  expect(store.db.prepare('SELECT body FROM prompt_workspace WHERE id=1').get()?.body).toBe(body);
});
