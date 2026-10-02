import { afterEach, expect, test } from 'vitest';
import { Store } from '../server/store.js';
import { createApp, type App } from '../server/app.js';
import {
  BUILTIN_ILLUSTRATION_PRESET,
  DEFAULT_ILLUSTRATION_PRESET_ID,
  emptyIllustrationPreset,
  illustrationPresetDefinition,
  illustrationPresetFile,
  parseIllustrationPresetFile,
  resolveIllustrationPreset,
  validateIllustrationPreset,
  type IllustrationPreset,
} from '../core/illustration-presets.js';
import {
  deleteIllustrationPreset,
  effectiveIllustrationPreset,
  illustrationPresetCatalog,
  illustrationPresetPreferences,
  readIllustrationPreset,
  selectIllustrationPreset,
} from '../server/illustration-presets.js';
import {
  cancelIllustration,
  claimIllustration,
  completeIllustration,
  illustrationJob,
  illustrationSettings,
  reserveIllustration,
  retryIllustration,
  scheduleAutomaticIllustration,
  updateIllustrationSettings,
} from '../server/illustrations.js';
import { saveResource, undoResource } from '../server/resource-service.js';
import { invokeResourceTool } from '../server/helper-resource-tools.js';
import { deleteChat } from '../server/chat-deletion.js';
import {
  chatWithSource,
  completedSource,
  fixtureIllustrationPreset,
  fixtureSettings,
  illustrationDatabases,
  PNG_BASE64,
} from './fixtures/illustration.js';
import { FIXTURE_WORKFLOW } from './fixtures/comfyui-server.js';
import { createFixtureChat } from './fixtures/chat.js';

const databases = illustrationDatabases('uimori-illustration-presets-');
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  databases.cleanup();
});
const save = (store: Store, title: string, styleGuidance = title) =>
  saveResource(store, {
    kind: 'illustration-preset',
    id: null,
    model: { ...emptyIllustrationPreset(title), styleGuidance },
  }).saved as IllustrationPreset;
const choose = (store: Store, presetId: string | null, scope = 'global', targetId?: string) =>
  selectIllustrationPreset(store, {
    scope,
    targetId,
    presetId,
    expectedRevision: illustrationPresetPreferences(store).revision,
  });

test('portable recipes validate the workflow and preserve text, not local IDs or execution settings', () => {
  const definition = {
    ...emptyIllustrationPreset('Portable'),
    styleGuidance: '빛'.repeat(2001),
    comfyui: { workflow: FIXTURE_WORKFLOW, negativeGuidance: '글'.repeat(1001) },
  };
  const file = illustrationPresetFile(definition);
  expect(parseIllustrationPresetFile(file)).toEqual(definition);
  expect(
    parseIllustrationPresetFile({
      ...file,
      preset: {
        ...definition,
        id: 'existing',
        revision: 99,
        generator: 'codex',
        automatic: true,
        codex: { model: { id: 'private' } },
        comfyui: {
          ...definition.comfyui,
          baseUrl: 'http://private:8188',
          authorizationEnv: 'PRIVATE_TOKEN',
        },
      },
    })
  ).toEqual(definition);
  for (const invalid of [null, [], { ...file, version: 3 }, { ...file, format: 'uimori-theme' }])
    expect(() => parseIllustrationPresetFile(invalid)).toThrow();
  expect(() => validateIllustrationPreset({ ...definition, title: ' ' })).toThrow();
  expect(() =>
    validateIllustrationPreset({
      ...definition,
      comfyui: { workflow: '{"nodes":[]}', negativeGuidance: '' },
    })
  ).toThrow('COMFYUI_WORKFLOW_UI_FORMAT');
  expect(() =>
    validateIllustrationPreset({ ...definition, comfyui: { workflow: '{}', negativeGuidance: '' } })
  ).toThrow('COMFYUI_WORKFLOW_INVALID');
  expect(() =>
    validateIllustrationPreset({ ...definition, styleGuidance: 'x'.repeat(2_000_001) })
  ).toThrow();
});

test('chat, bot and global selection resolve one whole recipe; inherit and stale IDs fall back predictably', () => {
  const store = databases.create();
  const chat = createFixtureChat(store, 'Scoped chat');
  const global = save(store, 'Global'),
    bot = save(store, 'Bot'),
    local = save(store, 'Chat');
  expect(effectiveIllustrationPreset(store, chat.id).id).toBe(DEFAULT_ILLUSTRATION_PRESET_ID);
  choose(store, global.id);
  expect(effectiveIllustrationPreset(store, chat.id).id).toBe(global.id);
  choose(store, bot.id, 'bot', chat.botId);
  choose(store, local.id, 'chat', chat.id);
  expect(effectiveIllustrationPreset(store, chat.id)).toEqual(local);
  expect(
    resolveIllustrationPreset(illustrationPresetCatalog(store), {
      chatId: chat.id,
      botId: chat.botId,
    })
  ).toEqual(local);
  choose(store, null, 'chat', chat.id);
  expect(effectiveIllustrationPreset(store, chat.id)).toEqual(bot);
  const preferences = illustrationPresetPreferences(store);
  preferences.chatPresets[chat.id] = 'missing';
  store.db
    .prepare('UPDATE app_metadata SET value=? WHERE key=?')
    .run(JSON.stringify(preferences), 'illustration-preset-preferences');
  expect(effectiveIllustrationPreset(store, chat.id)).toEqual(bot);
  expect(() =>
    selectIllustrationPreset(store, { scope: 'global', presetId: global.id, expectedRevision: 0 })
  ).toThrow('다른 창');
  expect(() => choose(store, 'missing')).toThrow();
  expect(() => choose(store, global.id, 'chat', 'missing')).toThrow();
  deleteIllustrationPreset(store, bot.id, bot.revision);
  expect(effectiveIllustrationPreset(store, chat.id)).toEqual(global);
});

test('shared resource saves support CAS and undo; creating and exporting never select or generate', () => {
  const store = databases.create();
  const preset = save(store, 'Ink');
  const preferences = illustrationPresetPreferences(store);
  const next = saveResource(store, {
    kind: 'illustration-preset',
    id: preset.id,
    expectedRevision: preset.revision,
    model: { ...illustrationPresetDefinition(preset), styleGuidance: 'pastel' },
  }).saved as IllustrationPreset;
  expect(() =>
    saveResource(store, {
      kind: 'illustration-preset',
      id: preset.id,
      expectedRevision: preset.revision,
      model: emptyIllustrationPreset('Stale'),
    })
  ).toThrow();
  expect(() => deleteIllustrationPreset(store, preset.id, preset.revision)).toThrow();
  const restored = undoResource(store, 'illustration-preset', preset.id, next.revision)
    .saved as IllustrationPreset;
  expect(restored.styleGuidance).toBe('Ink');
  const copy = saveResource(store, {
    kind: 'illustration-preset',
    id: null,
    model: parseIllustrationPresetFile(illustrationPresetFile(restored)),
  }).saved as IllustrationPreset;
  expect(copy.id).not.toBe(preset.id);
  expect(illustrationPresetPreferences(store)).toEqual(preferences);
  expect(store.db.prepare('SELECT count(*) AS n FROM illustration_jobs').get()?.n).toBe(0);
  expect(() => deleteIllustrationPreset(store, DEFAULT_ILLUSTRATION_PRESET_ID, 1)).toThrow();
  expect(() =>
    saveResource(store, {
      kind: 'illustration-preset',
      id: DEFAULT_ILLUSTRATION_PRESET_ID,
      expectedRevision: 1,
      model: emptyIllustrationPreset(),
    })
  ).toThrow();
});

test('queued work and explicit retries retain the old recipe after editing or deletion; new jobs use the latest selection', () => {
  const store = databases.create();
  const { chat, source } = chatWithSource(store);
  const preset = fixtureIllustrationPreset(store, { title: 'Ink', styleGuidance: 'ink wash' });
  const options = { testMode: true, settings: fixtureSettings() };
  const original = reserveIllustration(store, source, 'manual', options);
  const frozen = structuredClone(original.input);
  expect(frozen.preset).toEqual({ id: preset.id, title: 'Ink', revision: 1 });
  const updated = saveResource(store, {
    kind: 'illustration-preset',
    id: preset.id,
    expectedRevision: 1,
    model: {
      ...illustrationPresetDefinition(preset),
      title: 'Pastel',
      styleGuidance: 'pastel colors',
    },
  }).saved as IllustrationPreset;
  expect(illustrationJob(store, original.id).input).toEqual(frozen);
  cancelIllustration(store, original.id);
  retryIllustration(store, original.id);
  expect(illustrationJob(store, original.id).input).toEqual(frozen);
  const nextSource = completedSource(store, chat.id, 'A second scene.');
  const next = reserveIllustration(store, nextSource, 'manual', options);
  expect(next.input).toMatchObject({
    styleGuidance: 'pastel colors',
    preset: { id: preset.id, revision: 2, title: 'Pastel' },
  });
  deleteIllustrationPreset(store, preset.id, updated.revision);
  expect(illustrationJob(store, original.id).input).toEqual(frozen);
  const claimed = claimIllustration(store, original.id, 'test-worker')!;
  expect(
    completeIllustration(
      store,
      original.id,
      claimed.job.generation,
      'test-worker',
      [{ mime: 'image/png', bytes: Buffer.from(PNG_BASE64, 'base64'), caption: 'Preserved' }],
      { stage: 'store', attempts: [], retries: [] }
    )
  ).toBe(true);
  expect(effectiveIllustrationPreset(store, chat.id)).toEqual(BUILTIN_ILLUSTRATION_PRESET);
  expect(illustrationJob(store, next.id).input.preset?.title).toBe('Pastel');
});

test('ComfyUI freezes the selected workflow with the global environment, and automatic reservation uses the same scope', () => {
  const store = databases.create();
  const { chat, source } = chatWithSource(store);
  const preset = fixtureIllustrationPreset(store, {
    styleGuidance: 'ink',
    comfyui: { workflow: FIXTURE_WORKFLOW, negativeGuidance: 'text' },
  });
  const connection = store.product.connection({
    title: 'Synthetic',
    protocol: 'openai-chat-v1',
    endpoint: 'http://example.invalid/v1',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Prompt',
    connectionId: connection.id,
    modelId: 'test',
    maxOutputTokens: 1024,
    temperature: null,
  });
  const runtime = fixtureSettings({
    generator: 'comfyui',
    automatic: true,
    maxAutoRetries: 4,
    comfyui: {
      baseUrl: 'http://example.invalid:8188',
      authorizationEnv: 'TEST_TOKEN',
      promptModel: { id: model.id },
    },
  });
  const { revision, ...body } = runtime;
  updateIllustrationSettings(store, { expectedRevision: revision, ...body }, true);
  const job = reserveIllustration(store, source, 'manual');
  expect(job.input).toMatchObject({
    styleGuidance: 'ink',
    maxAutoRetries: 4,
    preset: { id: preset.id },
    comfyui: {
      workflow: FIXTURE_WORKFLOW,
      negativeGuidance: 'text',
      baseUrl: runtime.comfyui.baseUrl,
      authorizationEnv: 'TEST_TOKEN',
    },
  });
  const local = saveResource(store, {
    kind: 'illustration-preset',
    id: null,
    model: {
      ...emptyIllustrationPreset('Chat override'),
      generator: 'comfyui',
      styleGuidance: 'watercolor',
    },
  }).saved as IllustrationPreset;
  choose(store, local.id, 'chat', chat.id);
  const second = completedSource(store, chat.id, 'A different scene.');
  // The source commit already reserved automatically; it must fail visibly rather than silently reuse another workflow.
  const automatic = store.db
    .prepare('SELECT id FROM illustration_jobs WHERE source_revision=?')
    .get(second.id)!;
  expect(illustrationJob(store, String(automatic.id))).toMatchObject({
    status: 'failed',
    error: 'COMFYUI_WORKFLOW_MISSING',
    input: { styleGuidance: 'watercolor', preset: { id: local.id } },
  });
  expect(illustrationJob(store, job.id).input.comfyui?.workflow).toBe(FIXTURE_WORKFLOW);
  choose(store, preset.id, 'chat', chat.id);
  scheduleAutomaticIllustration(store, second);
  const queued = store.db
    .prepare("SELECT id FROM illustration_jobs WHERE source_revision=? AND status='queued'")
    .get(second.id)!;
  expect(illustrationJob(store, String(queued.id)).input.preset?.id).toBe(preset.id);
});

test('deleting a chat removes only its selection and keeps the shared recipe', () => {
  const store = databases.create();
  const chat = createFixtureChat(store, 'Remove selection');
  const preset = save(store, 'Shared');
  choose(store, preset.id, 'chat', chat.id);
  deleteChat(store, chat.id, {});
  expect(illustrationPresetPreferences(store).chatPresets).toEqual({});
  expect(readIllustrationPreset(store, preset.id)).toEqual(preset);
});

test('helper resource tools can author and discover recipes without selecting them or changing execution settings', () => {
  const store = databases.create();
  const before = illustrationSettings(store);
  const saved = invokeResourceTool(store, 'resource.save', {
    kind: 'illustration-preset',
    model: emptyIllustrationPreset('Helper recipe'),
  }) as { id: string; revision: number };
  expect(invokeResourceTool(store, 'illustration-preset.list', {})).toMatchObject({
    presets: expect.arrayContaining([
      { id: saved.id, revision: 1, title: 'Helper recipe', description: '', generator: 'codex' },
    ]),
  });
  expect(invokeResourceTool(store, 'illustration-preset.guide', {})).toHaveProperty('example');
  expect(
    invokeResourceTool(store, 'resource.read', { kind: 'illustration-preset', id: saved.id })
  ).toMatchObject({ title: 'Helper recipe' });
  expect(illustrationPresetPreferences(store).defaultPresetId).toBe(DEFAULT_ILLUSTRATION_PRESET_ID);
  expect(illustrationSettings(store)).toEqual(before);
  invokeResourceTool(store, 'resource.delete', {
    kind: 'illustration-preset',
    id: saved.id,
    expectedRevision: saved.revision,
  });
  expect(() => readIllustrationPreset(store, saved.id)).toThrow();
});

test('HTTP catalogue, resource save, selection, export and deletion honor separate revision boundaries', async () => {
  const store = databases.create();
  store.close();
  const app = await createApp({
    dbPath: store.path,
    buildId: 'illustration-presets-test',
    testMode: true,
  });
  apps.push(app);
  const before = (await app.inject('/api/illustration-settings')).json();
  const saved = await app.inject({
    method: 'POST',
    url: '/api/resources/save',
    payload: {
      kind: 'illustration-preset',
      model: { ...emptyIllustrationPreset('API recipe'), styleGuidance: 'ink' },
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const preset = saved.json().saved as IllustrationPreset;
  const file = await app.inject(`/api/illustration-presets/${preset.id}/export`);
  expect(file.statusCode).toBe(200);
  expect(parseIllustrationPresetFile(file.json())).toEqual(illustrationPresetDefinition(preset));
  const selected = await app.inject({
    method: 'POST',
    url: '/api/illustration-presets/selection',
    payload: { scope: 'global', presetId: preset.id, expectedRevision: 0 },
  });
  expect(selected.statusCode, selected.body).toBe(200);
  const stale = await app.inject({
    method: 'POST',
    url: '/api/illustration-presets/selection',
    payload: { scope: 'global', presetId: null, expectedRevision: 0 },
  });
  expect(stale.statusCode).toBe(409);
  expect((await app.inject('/api/illustration-settings')).json()).toEqual(before);
  const invalid = await app.inject({
    method: 'POST',
    url: '/api/resources/save',
    payload: { kind: 'illustration-preset', model: { title: '' } },
  });
  expect(invalid.statusCode).toBe(400);
  const deleted = await app.inject({
    method: 'DELETE',
    url: `/api/illustration-presets/${preset.id}`,
    payload: { expectedRevision: preset.revision },
  });
  expect(deleted.statusCode).toBe(200);
  expect((await app.inject('/api/illustration-presets')).json()).toMatchObject({
    preferences: { defaultPresetId: DEFAULT_ILLUSTRATION_PRESET_ID },
  });
});

test('legacy recipes infer their generator without rewriting stored versions and v2 keeps the explicit choice', () => {
  const store = databases.create();
  for (const workflow of ['', FIXTURE_WORKFLOW]) {
    const { generator: _generator, ...legacy } = {
      ...emptyIllustrationPreset('Legacy'),
      comfyui: { workflow, negativeGuidance: '' },
    };
    const saved = store.product.save('illustration-preset', legacy) as IllustrationPreset;
    const raw = store.product.get('illustration-preset', saved.id);
    const expected = workflow ? 'comfyui' : 'codex';
    expect(readIllustrationPreset(store, saved.id).generator).toBe(expected);
    expect(
      parseIllustrationPresetFile({
        format: 'uimori-illustration-preset',
        version: 1,
        preset: legacy,
      }).generator
    ).toBe(expected);
    expect(store.product.get('illustration-preset', saved.id)).toEqual(raw);
    expect(raw).not.toHaveProperty('generator');
    const file = illustrationPresetFile({ ...legacy, generator: 'codex' });
    expect(file.version).toBe(2);
    expect(parseIllustrationPresetFile(file).generator).toBe('codex'); // workflow presence does not override v2
    expect(() => parseIllustrationPresetFile({ ...file, preset: legacy })).toThrow('생성기');
    expect(() =>
      parseIllustrationPresetFile({ ...file, preset: { ...legacy, generator: 'unknown' } })
    ).toThrow();
  }
});

test('preset selection chooses its shared environment without changing global settings or already queued jobs', () => {
  const store = databases.create();
  const { chat, source } = chatWithSource(store);
  const connection = store.product.connection({
    title: 'Codex',
    protocol: 'codex-app-server-v1',
    endpoint: 'codex://local',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Synthetic',
    connectionId: connection.id,
    modelId: 'synthetic',
    maxOutputTokens: 1024,
    temperature: null,
  });
  const before = illustrationSettings(store);
  const { revision, ...body } = before;
  updateIllustrationSettings(store, {
    ...body,
    expectedRevision: revision,
    codex: { ...body.codex, model: { id: model.id } },
    comfyui: {
      ...body.comfyui,
      baseUrl: 'http://example.invalid:8188',
      promptModel: { id: model.id },
    },
  });
  const environment = illustrationSettings(store);
  const codex = fixtureIllustrationPreset(store, { generator: 'codex' });
  const original = reserveIllustration(store, source, 'manual');
  expect(original.input.generator).toBe('codex');
  const comfy = fixtureIllustrationPreset(store, { comfyui: { workflow: FIXTURE_WORKFLOW } });
  const nextSource = completedSource(store, chat.id, 'Another scene.');
  const next = reserveIllustration(store, nextSource, 'manual');
  expect(next.input).toMatchObject({
    generator: 'comfyui',
    comfyui: { baseUrl: environment.comfyui.baseUrl, workflow: FIXTURE_WORKFLOW },
  });
  expect(illustrationSettings(store)).toEqual(environment);
  cancelIllustration(store, original.id);
  retryIllustration(store, original.id);
  expect(illustrationJob(store, original.id).input).toEqual(original.input);
  expect(original.input.preset?.id).toBe(codex.id);
  expect(next.input.preset?.id).toBe(comfy.id);
  // An old disabled environment remains disabled for automatic work, but cannot choose a backend.
  store.db
    .prepare('UPDATE illustration_settings SET body=? WHERE id=1')
    .run(JSON.stringify({ ...environment, generator: 'none', automatic: true }));
  expect(illustrationSettings(store).automatic).toBe(false);
  expect(illustrationSettings(store)).not.toHaveProperty('generator');
});
