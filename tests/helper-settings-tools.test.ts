import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';
import { invokeHelperSettingsTool as call } from '../server/helper-settings-tools.js';
import { modelWorkspace, promptWorkspace } from '../server/prompt-workspace.js';
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
  const listed = call(store, 'model.list', {}) as { id: string; selectable: boolean }[];
  expect(listed).toContainEqual(expect.objectContaining({ id: selected.id, selectable: true }));
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
  expect(result.global.models.main).toEqual({ id: selected.id });
  expect(result.chat.effective.mainModel).toEqual({ id: selected.id });
  expect(result.chat.pinned.mainModel).toBeNull();
  expect(JSON.stringify(result)).not.toContain('nativeRisuPreset');
  expect(JSON.stringify(result)).not.toContain('127.0.0.1');
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
    mainModel: { id: selected.id },
    mainPromptPresetId: preset.id,
  });
  expect(read.chat.effective.mainPrompt).toEqual({
    title: 'Pinned writing prompt',
    presetId: preset.id,
    revision: preset.revision,
  });
  expect(promptWorkspace(store)).toEqual(before);
});

test('usage read returns the existing report for the requested period', () => {
  const report = call(database(), 'usage.read', { from: '2026-09-01', to: '2026-09-29' });
  expect(report).toMatchObject({
    from: '2026-09-01',
    to: '2026-09-29',
    timeZone: 'Asia/Seoul',
    totals: { calls: 0 },
  });
});
