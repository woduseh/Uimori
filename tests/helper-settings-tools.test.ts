import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';
import { invokeHelperSettingsTool as call } from '../server/helper-settings-tools.js';
import { modelWorkspace, promptWorkspace } from '../server/prompt-workspace.js';
import {
  illustrationPresetCatalog,
  saveIllustrationPreset,
} from '../server/illustration-presets.js';
import { emptyIllustrationPreset } from '../core/illustration-presets.js';
import type { ModelPreset } from '../core/product.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';

const owned: { path: string; store: Store }[] = [];
function database(): Store {
  const path = mkdtempSync(join(tmpdir(), 'uimori-helper-settings-'));
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
      !basename(path).startsWith('uimori-helper-settings-')
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

test('settings read shows selected references without prompt bodies or provider secrets', () => {
  const store = database(),
    chat = createFixtureChat(store, 'A'),
    selected = model(store, 'Selected');
  const listed = call(store, 'model.list', {}) as {
    models: { id: string; selectable: boolean }[];
    connections: { id: string }[];
  };
  expect(listed.models).toContainEqual(
    expect.objectContaining({ id: selected.id, selectable: true })
  );
  expect(listed.connections).toContainEqual(expect.objectContaining({ id: selected.connectionId }));
  expect(JSON.stringify(listed)).not.toContain('127.0.0.1');
  call(store, 'settings.update', {
    setting: 'global.mainModel',
    expectedRevision: modelWorkspace(store).revision,
    value: selected.id,
  });
  const result = call(store, 'settings.read', {}, chat.id) as {
    global: { revision: number; models: { main: { id: string } } };
    chat: { effective: { mainModel: { id: string } }; pinned: { mainModel: null } };
  };
  const choice = { id: selected.id, title: 'Selected', providerModelId: 'fixture' };
  expect(result.global.models.main).toEqual(choice);
  expect(result.chat.effective.mainModel).toEqual(choice);
  expect(result.chat.pinned.mainModel).toBeNull();
  expect(JSON.stringify(result)).not.toContain('nativeRisuPreset');
  expect(JSON.stringify(result)).not.toContain('127.0.0.1');
  store.db.prepare("INSERT INTO library_hidden(kind,id) VALUES('model',?)").run(selected.id);
  const hidden = call(store, 'settings.read', {}, chat.id) as typeof result;
  expect(hidden.global.models.main).toEqual({ id: selected.id, unavailable: true });
  expect(hidden.chat.effective.mainModel).toEqual({ id: selected.id, unavailable: true });
});

test('new-chat defaults can be changed without a selected chat and preserve existing chats', () => {
  const store = database();
  const existing = createFixtureChat(store, 'Existing');
  const read = () =>
    call(store, 'settings.read', {}) as {
      newChat: { revision: number; maxCalls: number; storyUi: boolean; storyUiStyle: string };
    };
  const update = (setting: string, value: unknown, expectedRevision = read().newChat.revision) =>
    call(store, 'settings.update', { setting, value, expectedRevision });
  expect(read().newChat).toMatchObject({ maxCalls: 8, storyUi: false, storyUiStyle: 'auto' });
  update('newChat.maxCalls', 128);
  update('newChat.storyUi', true);
  update('newChat.storyUiStyle', 'blue-archive');
  const next = createFixtureChat(store, 'New');
  expect(next.settings).toMatchObject({
    maxCalls: 128,
    storyUi: true,
    storyUiStyle: 'blue-archive',
  });
  expect(store.chat(existing.id).settings).toEqual(existing.settings);
  const stale = read().newChat.revision;
  update('newChat.maxCalls', 1);
  expect(() => update('newChat.storyUi', false, stale)).toThrow();
  expect(() => update('newChat.maxCalls', 129)).toThrow();
  expect(store.chat(next.id).settings).toEqual(next.settings);
  expect(read().newChat).toMatchObject({
    maxCalls: 1,
    storyUi: true,
    storyUiStyle: 'blue-archive',
  });
});

test('global model update preserves other selections and rejects stale or unknown IDs', () => {
  const store = database(),
    a = model(store, 'A'),
    b = model(store, 'B');
  const first = modelWorkspace(store);
  call(store, 'settings.update', {
    setting: 'global.translationModel',
    expectedRevision: first.revision,
    value: a.id,
  });
  const prior = promptWorkspace(store);
  call(store, 'settings.update', {
    setting: 'global.mainModel',
    expectedRevision: prior.revision,
    value: b.id,
  });
  const next = promptWorkspace(store);
  expect(next.modelRoutes).toEqual({ main: { id: b.id }, translation: { id: a.id } });
  expect(next.translationPolicy).toEqual(prior.translationPolicy);
  expect(next.main.program).toEqual(prior.main.program);
  expect(() =>
    call(store, 'settings.update', {
      setting: 'global.mainModel',
      expectedRevision: prior.revision,
      value: a.id,
    })
  ).toThrow();
  expect(() =>
    call(store, 'settings.update', {
      setting: 'global.mainModel',
      expectedRevision: next.revision,
      value: 'missing',
    })
  ).toThrow();
  expect(promptWorkspace(store)).toEqual(next);
});

test('chat overrides and ordinary settings change only their selected fields', () => {
  const store = database(),
    chat = createFixtureChat(store, 'A'),
    selected = model(store, 'Local');
  const original = store.product.profile(chat.id);
  const pinned = call(
    store,
    'settings.update',
    {
      setting: 'chat.mainModel',
      expectedRevision: original.revision,
      value: selected.id,
    },
    chat.id
  ) as { revision: number };
  expect(store.product.profile(chat.id).pinned?.mainModel).toEqual({ id: selected.id });
  expect(store.product.profile(chat.id).imageTranslation).toBe(original.imageTranslation);
  const current = store.chat(chat.id);
  call(
    store,
    'settings.update',
    {
      setting: 'chat.maxCalls',
      expectedRevision: current.settingsRevision,
      value: 5,
    },
    chat.id
  );
  expect(store.chat(chat.id).settings).toEqual({ ...current.settings, maxCalls: 5 });
  expect(() =>
    call(
      store,
      'settings.update',
      {
        setting: 'chat.mainModel',
        expectedRevision: original.revision,
        value: null,
      },
      chat.id
    )
  ).toThrow();
  expect(() =>
    call(
      store,
      'settings.update',
      {
        setting: 'chat.status',
        expectedRevision: current.settingsRevision,
        value: false,
      },
      chat.id
    )
  ).toThrow();
  call(
    store,
    'settings.update',
    {
      setting: 'chat.mainModel',
      expectedRevision: pinned.revision,
      value: null,
    },
    chat.id
  );
  expect(store.product.profile(chat.id).pinned).toBeUndefined();
  expect(store.chat(chat.id).settings.maxCalls).toBe(5);
});

test('chat prompt pin reports the effective prompt and preserves the model pin', () => {
  const store = database(),
    chat = createFixtureChat(store, 'A'),
    selected = model(store, 'Local');
  const preset = store.product.save('prompt-preset', {
    title: 'Pinned writing prompt',
    role: 'main',
    program: createDefaultRisuPrompt('Pinned writing prompt'),
    values: {},
  });
  const before = promptWorkspace(store);
  const first = call(
    store,
    'settings.update',
    {
      setting: 'chat.mainModel',
      expectedRevision: store.product.profile(chat.id).revision,
      value: selected.id,
    },
    chat.id
  ) as { revision: number };
  call(
    store,
    'settings.update',
    {
      setting: 'chat.mainPromptPreset',
      expectedRevision: first.revision,
      value: preset.id,
    },
    chat.id
  );
  const read = call(store, 'settings.read', {}, chat.id) as {
    chat: {
      pinned: { mainModel: { id: string }; mainPromptPresetId: string };
      effective: { mainPrompt: { title: string; presetId: string; revision: number } };
    };
  };
  expect(read.chat.pinned).toEqual({
    mainModel: { id: selected.id, title: 'Local', providerModelId: 'fixture' },
    mainPromptPresetId: preset.id,
  });
  expect(read.chat.effective.mainPrompt).toEqual({
    title: 'Pinned writing prompt',
    presetId: preset.id,
    revision: preset.revision,
  });
  expect(promptWorkspace(store)).toEqual(before);
});

test('model.register saves a model on a connection and model.delete refuses while a role still uses it', () => {
  const store = database();
  const existing = model(store, 'Existing');
  const registered = call(store, 'model.register', {
    connectionId: existing.connectionId,
    providerModelId: 'fixture-next',
    title: 'Next',
  }) as { modelId: string; revision: number };
  expect(store.product.stored<ModelPreset>('model', registered.modelId)).toMatchObject({
    title: 'Next',
    connectionId: existing.connectionId,
    modelId: 'fixture-next',
    maxOutputTokens: 8192,
  });
  expect(() =>
    call(store, 'model.register', {
      connectionId: existing.connectionId,
      providerModelId: 'fixture-next',
      title: 'Next',
      endpoint: 'http://attacker.invalid',
    })
  ).toThrow();
  call(store, 'settings.update', {
    setting: 'global.helperModel',
    expectedRevision: modelWorkspace(store).revision,
    value: registered.modelId,
  });
  expect(() =>
    call(store, 'model.delete', {
      modelId: registered.modelId,
      expectedRevision: registered.revision,
    })
  ).toThrow(/MODEL_IN_USE: .*helper/);
  call(store, 'settings.update', {
    setting: 'global.helperModel',
    expectedRevision: modelWorkspace(store).revision,
    value: existing.id,
  });
  expect(
    call(store, 'model.delete', {
      modelId: registered.modelId,
      expectedRevision: registered.revision,
    })
  ).toMatchObject({ deleted: true, modelId: registered.modelId });
  expect((store.product.all('model') as ModelPreset[]).map((item) => item.id)).not.toContain(
    registered.modelId
  );
});

test('settings.update applies global prompt presets, automatic translation and new chat defaults', () => {
  const store = database();
  const preset = store.product.save('prompt-preset', {
    title: 'House writing prompt',
    role: 'main',
    program: createDefaultRisuPrompt('House writing prompt'),
    values: {},
  });
  const read = () =>
    call(store, 'settings.read', {}) as {
      global: { revision: number; prompts: { main: { presetId: string | null } } };
      autoTranslation: { revision: number; autoTranslate: boolean; translationLanguage: string };
      newChat: { revision: number; autoRefusalRetryEnabled: boolean };
      loreContextDefaults: { revision: number; maxRetainedEntries: number } & Record<
        string,
        unknown
      >;
    };
  call(store, 'settings.update', {
    setting: 'global.mainPromptPreset',
    expectedRevision: read().global.revision,
    value: preset.id,
  });
  expect(read().global.prompts.main.presetId).toBe(preset.id);
  expect(() =>
    call(store, 'settings.update', {
      setting: 'global.translationPromptPreset',
      expectedRevision: read().global.revision,
      value: preset.id,
    })
  ).toThrow('Prompt role mismatch');
  call(store, 'settings.update', {
    setting: 'global.autoTranslate',
    expectedRevision: read().autoTranslation.revision,
    value: true,
  });
  call(store, 'settings.update', {
    setting: 'global.translationLanguage',
    expectedRevision: read().autoTranslation.revision,
    value: 'en',
  });
  expect(read().autoTranslation).toMatchObject({ autoTranslate: true, translationLanguage: 'en' });
  call(store, 'settings.update', {
    setting: 'newChat.autoRefusalRetryEnabled',
    expectedRevision: read().newChat.revision,
    value: false,
  });
  expect(read().newChat.autoRefusalRetryEnabled).toBe(false);
  const { revision, ...policy } = read().loreContextDefaults;
  call(store, 'settings.update', {
    setting: 'newChat.loreContext',
    expectedRevision: revision,
    value: { ...policy, maxRetainedEntries: 12 },
  });
  expect(read().loreContextDefaults.maxRetainedEntries).toBe(12);
  expect(() =>
    call(store, 'settings.update', {
      setting: 'newChat.loreContext',
      expectedRevision: revision + 1,
      value: { maxRetainedEntries: 3 },
    })
  ).toThrow('Invalid lore context defaults');
});

test('illustration-preset.select chooses a preset for one chat without touching the global default', () => {
  const store = database();
  const chat = createFixtureChat(store, 'Painted');
  const other = saveIllustrationPreset(store, emptyIllustrationPreset('Ink wash'));
  const catalog = illustrationPresetCatalog(store);
  call(store, 'illustration-preset.select', {
    scope: 'chat',
    targetId: chat.id,
    presetId: other.id,
    expectedRevision: catalog.preferences.revision,
  });
  const preferences = illustrationPresetCatalog(store).preferences;
  expect(preferences.chatPresets[chat.id]).toBe(other.id);
  expect(preferences.defaultPresetId).toBe(catalog.preferences.defaultPresetId);
  expect(() =>
    call(store, 'illustration-preset.select', {
      scope: 'chat',
      targetId: chat.id,
      presetId: null,
      expectedRevision: catalog.preferences.revision,
    })
  ).toThrow();
});
