import { reserveIllustration } from './fixtures/illustration.js';
import { afterEach, expect, test } from 'vitest';
import { Store } from '../server/store.js';
import { type App } from '../server/app.js';
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
  retryIllustration,
} from '../server/illustrations.js';
import { saveResource, undoResource } from '../server/resource-service.js';
import { deleteChat } from '../server/chat-deletion.js';
import { deleteLibraryItem } from '../server/library-deletion.js';
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
  const invalidations: string[] = [];
  store.observeInvalidations((name) => invalidations.push(name));
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
  ).toThrow('REVISION_CONFLICT');
  expect(() => choose(store, 'missing')).toThrow();
  expect(() => choose(store, global.id, 'chat', 'missing')).toThrow();
  const shown = illustrationPresetPreferences(store).revision;
  deleteIllustrationPreset(store, bot.id, bot.revision);
  expect(() =>
    selectIllustrationPreset(store, { scope: 'global', presetId: bot.id, expectedRevision: shown })
  ).toThrow('REVISION_CONFLICT');
  expect(effectiveIllustrationPreset(store, chat.id)).toEqual(global);
  expect(invalidations).toEqual(Array(8).fill('illustration-presets'));
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

test('deleting a chat removes only its selection and keeps the shared recipe', () => {
  const store = databases.create();
  const chat = createFixtureChat(store, 'Remove selection');
  const preset = save(store, 'Shared');
  choose(store, preset.id, 'chat', chat.id);
  deleteChat(store, chat.id, {});
  expect(illustrationPresetPreferences(store).chatPresets).toEqual({});
  expect(readIllustrationPreset(store, preset.id)).toEqual(preset);
});

test('a stale tab cannot select a recipe for a deleted bot or chat', () => {
  const store = databases.create();
  const chat = createFixtureChat(store, 'Gone chat');
  const preset = save(store, 'Shared');
  deleteLibraryItem(store, 'content', chat.botId, {
    expectedRevision: store.product.get<{ revision: number }>('content', chat.botId).revision,
  });
  expect(() => choose(store, preset.id, 'bot', chat.botId)).toThrow('REVISION_CONFLICT');
  expect(illustrationPresetPreferences(store).botPresets).toEqual({});
  deleteChat(store, chat.id, {});
  expect(() => choose(store, preset.id, 'chat', chat.id)).toThrow('REVISION_CONFLICT');
  expect(() => choose(store, preset.id, 'bot', chat.botId)).toThrow('REVISION_CONFLICT');
});

test('v1 preset files infer their generator and v2 files keep the explicit choice', () => {
  for (const workflow of ['', FIXTURE_WORKFLOW]) {
    const { generator: _generator, ...legacy } = {
      ...emptyIllustrationPreset('Legacy'),
      comfyui: { workflow, negativeGuidance: '' },
    };
    expect(
      parseIllustrationPresetFile({
        format: 'uimori-illustration-preset',
        version: 1,
        preset: legacy,
      }).generator
    ).toBe(workflow ? 'comfyui' : 'codex');
    const file = illustrationPresetFile({ ...legacy, generator: 'codex' });
    expect(file.version).toBe(2);
    expect(parseIllustrationPresetFile(file).generator).toBe('codex');
    expect(() => parseIllustrationPresetFile({ ...file, preset: legacy })).toThrow(
      expect.objectContaining({ code: 'ILLUSTRATION_PRESET_GENERATOR_REQUIRED' })
    );
    expect(() =>
      parseIllustrationPresetFile({ ...file, preset: { ...legacy, generator: 'unknown' } })
    ).toThrow();
  }
});
