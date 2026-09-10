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
import {
  MODEL_ROLES,
  workspaceModelRef,
  type ChatProfile,
  type PromptPreset,
} from '../core/product.js';
import { ChatOptionsStore } from '../server/chat-options.js';
import { forkChat } from '../server/chat-fork.js';
import { managementImpact } from '../server/provider-management.js';
import { illustrationReferenceCandidates } from '../server/illustrations.js';
import { helperWritingSnapshot } from '../server/helper-runtime.js';
import { contextSourceRefs } from '../server/context-planning.js';

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

function pin(store: Store, chatId: string, pinned: unknown, expectedRevision?: number) {
  const prior = store.product.profile(chatId);
  return store.product.updateProfile(chatId, {
    expectedRevision: expectedRevision ?? prior.revision,
    attachments: prior.attachments,
    image: prior.image,
    ...(pinned === undefined ? {} : { pinned }),
  });
}
function mainPreset(store: Store, title: string) {
  const program = createDefaultPromptProgram(title);
  program.controls = [{ id: 'detail', label: 'Detail', type: 'boolean', default: false }];
  return store.product.save('prompt-preset', {
    title,
    role: 'main',
    program,
    values: { detail: false },
  }) as PromptPreset;
}

test('workspace role resolution keeps optional and refusal selections separate from execution roles', () => {
  const workspace = promptWorkspace(database());
  const roles = [
    'main',
    'translation',
    'status',
    'image',
    'helper',
    'context',
    'title',
    'refusal',
  ] as const;
  expect(roles.map((role) => workspaceModelRef(workspace, role))).toEqual(roles.map(() => null));
  workspace.modelRoutes.main = { id: 'main' };
  workspace.helperModel = { id: 'helper' };
  workspace.contextModel = { id: 'context' };
  workspace.titleModel = { id: 'title' };
  workspace.translationPolicy.refusalModel = { id: 'refusal' };
  expect(roles.map((role) => workspaceModelRef(workspace, role)?.id ?? null)).toEqual([
    'main',
    null,
    null,
    null,
    'helper',
    'context',
    'title',
    'refusal',
  ]);
  expect(new Set(MODEL_ROLES).size).toBe(9);
  expect(MODEL_ROLES).toContain('illustration');
  expect(MODEL_ROLES).not.toContain('refusal');
});

test('chat pins follow the latest selected IDs while other chats and auxiliary models follow global defaults', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Pinned'),
    other = createFixtureChat(store, 'Global'),
    globalA = model(store, 'Global A'),
    globalB = model(store, 'Global B'),
    local = model(store, 'Pinned model'),
    preset = mainPreset(store, 'Pinned prompt');
  select(store, globalA.id);
  const pinned = { mainPromptPresetId: preset.id, mainModel: { id: local.id } };
  const before = promptWorkspace(store);
  const saved = pin(store, chat.id, pinned);
  expect(saved.routes.main).toEqual(pinned.mainModel);
  expect(promptWorkspace(store)).toEqual(before);
  const first = complete(store, chat.id);
  expect(first.run.snapshot.profile).toMatchObject({
    pinned,
    models: { main: { id: local.id }, translation: { id: globalA.id } },
    prompts: { main: { id: preset.id, revision: preset.revision } },
    promptPresets: { main: { program: preset.program } },
    promptOptionOwner: `preset:${preset.id}`,
  });
  select(store, globalB.id);
  const current = promptWorkspace(store);
  updatePromptWorkspace(store, {
    expectedRevision: current.revision,
    main: {
      title: 'Later global prompt',
      program: createDefaultPromptProgram('Global B'),
      values: {},
    },
  });
  const latest = store.product.save(
    'prompt-preset',
    {
      title: 'Pinned prompt revised',
      role: 'main',
      program: { ...preset.program, blocks: createDefaultPromptProgram('Pinned latest').blocks },
      values: { detail: true },
    },
    preset.id,
    preset.revision
  ) as PromptPreset;
  store.product.model(
    {
      title: 'Pinned model revised',
      connectionId: local.connectionId,
      modelId: local.modelId,
      maxOutputTokens: 1024,
      temperature: null,
      expectedRevision: local.revision,
    },
    local.id
  );
  const next = store.product.snapshot(chat.id);
  expect(next.models.main).toMatchObject({ id: local.id, title: 'Pinned model revised' });
  expect(next.models.translation?.id).toBe(globalB.id);
  expect(next.promptPresets?.main).toMatchObject({
    id: latest.id,
    revision: latest.revision,
    program: latest.program,
  });
  expect(next.promptControls?.[`${latest.id}@${latest.revision}`]?.values).toEqual({
    detail: true,
  });
  expect(store.product.snapshot(other.id).models.main?.id).toBe(globalB.id);
  expect(store.product.snapshot(other.id).promptPresets?.main?.program).toEqual(
    promptWorkspace(store).main.program
  );
  expect(store.run(first.run.id)).toEqual(first.run);
  expect(pin(store, chat.id, undefined).pinned).toEqual(pinned);
  const cleared = pin(store, chat.id, {});
  expect(cleared.pinned).toBeUndefined();
  expect(cleared.routes.main?.id).toBe(globalB.id);
  expect(store.product.snapshot(chat.id).promptPresets?.main?.program).toEqual(
    promptWorkspace(store).main.program
  );
});

test('pin writes reject stale revisions, invalid references and non-main prompts without partial changes', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Pin validation'),
    local = model(store, 'Local'),
    preset = mainPreset(store, 'Main');
  const translation = store.product.save('prompt-preset', {
    title: 'Translation',
    role: 'translation',
    program: createDefaultPromptProgram('Translation', 'translation'),
  });
  const before = store.product.profile(chat.id);
  for (const invalid of [
    null,
    { mainModel: null },
    { mainModel: { id: local.id, revision: 1 } },
    { mainModel: { id: 'missing' } },
    { mainPromptPresetId: 'missing' },
    { mainPromptPresetId: translation.id },
    { translationModel: { id: local.id } },
  ]) {
    expect(() => pin(store, chat.id, invalid)).toThrow();
    expect(store.product.profile(chat.id)).toEqual(before);
  }
  pin(store, chat.id, { mainPromptPresetId: preset.id });
  expect(() => pin(store, chat.id, { mainModel: { id: local.id } }, before.revision)).toThrow(
    /revision conflict/
  );
  expect(store.product.profile(chat.id).pinned).toEqual({ mainPromptPresetId: preset.id });
  store.db
    .prepare(
      "UPDATE provider_settings SET body=json_set(body,'$.enabled',json('false')) WHERE kind='model' AND id=?"
    )
    .run(local.id);
  expect(() => pin(store, chat.id, { mainModel: { id: local.id } })).toThrow(/비활성/);
});

test('deleted or disabled pins block new main work while profile repair and global translation remain available', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Unavailable pin'),
    global = model(store, 'Global'),
    local = model(store, 'Pinned'),
    preset = mainPreset(store, 'Pinned');
  select(store, global.id);
  pin(store, chat.id, { mainModel: { id: local.id }, mainPromptPresetId: preset.id });
  const first = complete(store, chat.id);
  const prepared = helperWritingSnapshot(store, chat.id, `main:${chat.id}`, 'context');
  prepared.contextPlan = {
    ...prepared.contextPlan!,
    status: 'ready',
    compacted: contextSourceRefs(prepared),
    recentSourceRevisions: [],
    summary: 'Preserved synthetic summary.',
    estimatedInputTokens: 100,
  };
  store.context.publishPrepared(prepared, { origin: 'automatic' });
  const checkpoint = store.context.detail(chat.id).checkpoint;
  expect(checkpoint?.plan.summary).toBe('Preserved synthetic summary.');
  const imageCandidates = illustrationReferenceCandidates(store, chat.id);
  store.db
    .prepare(
      "UPDATE provider_settings SET body=json_set(body,'$.enabled',json('false')) WHERE kind='model' AND id=?"
    )
    .run(local.id);
  expect(() => store.product.snapshot(chat.id)).toThrow(/MODEL_UNAVAILABLE:main/);
  expect(store.product.profile(chat.id).routes.main?.id).toBe(local.id);
  deleteLibraryItem(store, 'prompt-preset', preset.id, { expectedRevision: preset.revision });
  expect(() => store.product.snapshot(chat.id)).toThrow(/PINNED_PROMPT_UNAVAILABLE/);
  expect(() => new ChatOptionsStore(store).get(chat.id)).toThrow(/PINNED_PROMPT_UNAVAILABLE/);
  expect(illustrationReferenceCandidates(store, chat.id)).toEqual(imageCandidates);
  expect(store.context.detail(chat.id)).toMatchObject({ checkpoint, usable: false });
  expect(store.requestTranslation(first.source.id).input).toMatchObject({
    translationModelSelection: { id: global.id },
  });
  expect(pin(store, chat.id, undefined).pinned?.mainPromptPresetId).toBe(preset.id);
  deleteLibraryItem(store, 'model', local.id, { expectedRevision: local.revision });
  pin(store, chat.id, { mainModel: { id: local.id } });
  expect(() => store.product.snapshot(chat.id)).toThrow(/MODEL_UNAVAILABLE:main/);
  expect(store.run(first.run.id)).toEqual(first.run);
  pin(store, chat.id, {});
  expect(store.product.snapshot(chat.id).models.main?.id).toBe(global.id);
});

test('changing a pin invalidates pending options and preserves the pending draft when reservation fails', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Pinned options'),
    presetA = mainPreset(store, 'A'),
    presetB = mainPreset(store, 'B');
  select(store, model(store, 'Fixture').id);
  pin(store, chat.id, { mainPromptPresetId: presetA.id });
  const options = new ChatOptionsStore(store),
    state = options.get(chat.id);
  options.stage(
    chat.id,
    {
      branchId: state.branchId,
      expectedRevision: state.revision,
      binding: state.binding,
      values: { detail: true },
      operationId: randomUUID(),
      expectedHeadRevision: state.headRevision,
    },
    { requestId: 'pin-test', assert: () => {} }
  );
  pin(store, chat.id, { mainPromptPresetId: presetB.id });
  expect(options.get(chat.id).binding.owner).toBe(`preset:${presetB.id}`);
  expect(options.get(chat.id).conflicts.join(' ')).toMatch(/다음 요청 옵션/);
  expect(() => complete(store, chat.id)).toThrow(/프롬프트가 바뀌었어요/);
  expect(options.get(chat.id).pending).toHaveLength(1);
  expect(store.db.prepare('SELECT count(*) AS count FROM runs').get()?.count).toBe(0);
  pin(store, chat.id, { mainPromptPresetId: presetA.id });
  const completed = complete(store, chat.id);
  expect(completed.run.snapshot.profile?.chatOptions?.values).toEqual({ detail: true });
  expect(options.get(chat.id).pending).toHaveLength(0);
});

test('fork and archive preserve chat pins and frozen prompt contents after a later preset edit', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Pin archive'),
    local = model(store, 'Local'),
    preset = mainPreset(store, 'Original');
  const pinned: ChatProfile['pinned'] = {
    mainPromptPresetId: preset.id,
    mainModel: { id: local.id },
  };
  pin(store, chat.id, pinned);
  const first = complete(store, chat.id);
  store.product.save(
    'prompt-preset',
    { ...preset, program: createDefaultPromptProgram('Later'), values: {} },
    preset.id,
    preset.revision
  );
  const fork = forkChat(store, chat.id, {
    fromRevision: first.source.id,
    title: 'Fork',
    idempotencyKey: randomUUID(),
  });
  expect(store.product.profile(fork.id).pinned).toEqual(pinned);
  expect(store.product.snapshot(fork.id).promptPresets?.main?.revision).toBe(2);
  const archive = store.product.export(),
    restored = database();
  restored.product.import(archive);
  expect(restored.product.profile(chat.id).pinned).toEqual(pinned);
  expect(restored.product.profile(fork.id).pinned).toEqual(pinned);
  expect(restored.run(first.run.id).snapshot.profile?.promptPresets?.main).toEqual(
    first.run.snapshot.profile?.promptPresets?.main
  );
  const damaged = structuredClone(archive);
  const body = JSON.parse(damaged.tables.profiles[0].body);
  body.pinned.mainModel.extra = 'invalid';
  damaged.tables.profiles[0].body = JSON.stringify(body);
  const target = database(),
    before = target.product.export();
  expect(() => target.product.import(damaged)).toThrow(/Unknown request field/);
  expect(target.product.export().tables).toEqual(before.tables);
});

test('model management impact attributes a pinned chat to its effective main model', () => {
  const store = database(),
    pinnedChat = createFixtureChat(store, 'Pinned'),
    globalChat = createFixtureChat(store, 'Global'),
    global = model(store, 'Global main'),
    local = model(store, 'Local main');
  const current = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: current.revision,
    routes: { ...emptyModelRoutes(), main: { id: global.id } },
    translationPolicy: current.translationPolicy,
  });
  pin(store, pinnedChat.id, { mainModel: { id: local.id } });
  expect(managementImpact(store.product, 'model', global.id).profiles).toEqual([
    { chatId: globalChat.id, title: globalChat.title, roles: ['main'] },
  ]);
  expect(managementImpact(store.product, 'connection', local.connectionId).profiles).toEqual([
    { chatId: pinnedChat.id, title: pinnedChat.title, roles: ['main'] },
  ]);
});
