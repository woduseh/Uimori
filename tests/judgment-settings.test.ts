import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { Store } from '../server/store.js';
import {
  defaultPromptWorkspace,
  modelWorkspace,
  promptWorkspace,
  updateModelWorkspace,
  validatePromptWorkspace,
} from '../server/prompt-workspace.js';
import { validateTranslationJudgmentPolicy } from '../core/translation-settings.js';
import { createFixtureChat } from './fixtures/chat.js';

const stores: { store: Store; directory: string }[] = [];
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-judgment-settings-'));
  const store = new Store(join(directory, 'data.sqlite'));
  stores.push({ store, directory });
  return store;
}
afterEach(() => {
  for (const { store, directory } of stores.splice(0)) {
    store.close();
    const within = relative(tmpdir(), directory);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !within.startsWith('uimori-judgment-settings-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('independent judgment settings persist and new workspaces default main judgment off independently of translation', () => {
  const store = setup();
  const original = store.db.prepare('SELECT body FROM prompt_workspace WHERE id=1').get();
  expect(modelWorkspace(store).mainJudgmentEnabled).toBe(false);
  expect(modelWorkspace(store).mainJudgmentThreshold).toBe(0.9);
  expect(store.db.prepare('SELECT body FROM prompt_workspace WHERE id=1').get()).toEqual(original);
  const current = modelWorkspace(store);
  const changed = updateModelWorkspace(store, {
    expectedRevision: current.revision,
    routes: current.routes,
    mainJudgmentEnabled: false,
    translationPolicy: {
      ...current.translationPolicy,
      judgment: { threshold: 0.85, enabled: true },
    },
  });
  expect(changed.mainJudgmentEnabled).toBe(false);
  expect(promptWorkspace(store).translationPolicy.judgment).toEqual({
    threshold: 0.85,
    enabled: true,
  });
  const next = updateModelWorkspace(store, {
    expectedRevision: changed.revision,
    routes: changed.routes,
    translationPolicy: {
      ...changed.translationPolicy,
      judgment: { threshold: 0.85, enabled: false },
    },
  });
  expect(next.mainJudgmentEnabled).toBe(false);
  expect(next.translationPolicy.judgment.enabled).toBe(false);
});

test('judgment flags reject non-boolean settings', () => {
  for (const invalid of [null, 0, 'false', {}]) {
    expect(() =>
      validatePromptWorkspace({ ...defaultPromptWorkspace(), mainJudgmentEnabled: invalid })
    ).toThrow();
    expect(() => validateTranslationJudgmentPolicy({ threshold: 0.9, enabled: invalid })).toThrow();
  }
});

test('main judgment settings remain fixed for an in-flight request', () => {
  const store = setup();
  const chat = createFixtureChat(store, 'Judgment snapshot');
  const current = modelWorkspace(store);
  const changed = updateModelWorkspace(store, {
    expectedRevision: current.revision,
    routes: current.routes,
    translationPolicy: current.translationPolicy,
    mainJudgmentEnabled: false,
    mainJudgmentThreshold: 0.75,
  });
  const run = store.createRun(
    chat.id,
    {
      request: 'Scene',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: 'judgment-freeze',
    },
    () => ({
      chatId: chat.id,
      parentRevision: null,
      settingsRevision: chat.settingsRevision,
      settings: chat.settings,
      request: 'Scene',
      history: [],
      resources: [],
    })
  ).run;
  updateModelWorkspace(store, {
    expectedRevision: changed.revision,
    routes: changed.routes,
    translationPolicy: changed.translationPolicy,
    mainJudgmentEnabled: true,
    mainJudgmentThreshold: 0.95,
  });
  expect(store.run(run.id).snapshot.mainJudgmentEnabled).toBe(false);
  expect(store.run(run.id).snapshot.mainJudgmentThreshold).toBe(0.75);
  expect(modelWorkspace(store).mainJudgmentThreshold).toBe(0.95);
});

test('main threshold rejects nonnumeric and out-of-range settings and snapshots', () => {
  for (const invalid of [null, '0.9', 0.5, 1.01, NaN, Infinity]) {
    expect(() =>
      validatePromptWorkspace({ ...defaultPromptWorkspace(), mainJudgmentThreshold: invalid })
    ).toThrow('MAIN_JUDGMENT_THRESHOLD_INVALID');
  }
  expect(
    validatePromptWorkspace({ ...defaultPromptWorkspace(), mainJudgmentThreshold: 1 })
      .mainJudgmentThreshold
  ).toBe(1);
});
