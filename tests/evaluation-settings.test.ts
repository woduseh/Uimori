import { updateTestProfile } from './fixtures/model-workspace.js';
import { createFixtureChat } from './fixtures/chat.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import {
  defaultEvaluationToolOptions,
  validateEvaluationToolOptions,
} from '../core/evaluation-tool-config.js';
import type { Connection, ModelPreset } from '../core/product.js';

const owned: { directory: string; store: Store }[] = [];
const database = () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-evaluation-settings-'));
  const store = new Store(join(directory, 'test.sqlite'));
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
      !basename(target).startsWith('uimori-evaluation-settings-')
    )
      throw new Error('Unsafe test cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});
const connection = (store: Store, protocol: Connection['protocol'] = 'openai-responses-v1') =>
  store.product.connection({
    title: 'Synthetic',
    protocol,
    endpoint:
      protocol === 'anthropic-messages-v1'
        ? 'https://api.anthropic.com/v1'
        : 'https://api.openai.com/v1',
    enabled: true,
    credentialRef: 'My_Gateway_Key',
  }) as Connection;
const modelBody = (c: Connection, extra: Record<string, unknown> = {}) => ({
  title: 'Synthetic',
  connectionId: c.id,
  modelId: 'synthetic-model',
  maxOutputTokens: 8192,
  temperature: null,
  ...extra,
});

test('tool options are explicit and independently validated', () => {
  const defaults = defaultEvaluationToolOptions();
  expect(defaults).toEqual({
    contextMode: 'model-selected',
    approvalReasoningMode: 'configured',
    maximumToolRounds: 8,
    terminalLateCorrections: false,
    outputRecovery: true,
  });
  expect(validateEvaluationToolOptions(defaults)).toEqual(defaults);
  for (const invalid of [
    undefined,
    null,
    {},
    { ...defaults, maximumToolRounds: 33 },
    { ...defaults, maximumToolRounds: -1 },
    { ...defaults, outputRecovery: undefined },
    { ...defaults, serviceTier: 'flex' },
    { ...defaults, extra: true },
  ])
    expect(() => validateEvaluationToolOptions(invalid)).toThrow('INVALID_EVALUATION_TOOL_OPTIONS');
  expect(
    validateEvaluationToolOptions({ ...defaults, maximumToolRounds: 0, outputRecovery: false })
  ).toMatchObject({ maximumToolRounds: 0, outputRecovery: false });
});

test('only selected model presets persist evaluation tools and captured runs retain earlier settings', () => {
  const store = database();
  for (const protocol of ['openai-responses-v1', 'anthropic-messages-v1'] as const) {
    const c = connection(store, protocol),
      disabled = store.product.model(modelBody(c)) as ModelPreset;
    expect(disabled).not.toHaveProperty('evaluationTools');
    const selected = store.product.model(
      modelBody(c, { evaluationTools: defaultEvaluationToolOptions() })
    ) as ModelPreset;
    expect(selected.evaluationTools).toEqual(defaultEvaluationToolOptions());
    const chat = createFixtureChat(store, `Synthetic ${protocol}`),
      prior = store.product.profile(chat.id);
    updateTestProfile(store.product, chat.id, {
      expectedRevision: prior.revision,
      packageAttachments: prior.packageAttachments,

      routes: { ...prior.routes, main: { id: selected.id } },
      image: false,
    });
    const captured = store.product.snapshot(chat.id)!;
    const run = store.createRun(
      chat.id,
      {
        request: 'Synthetic evaluation snapshot',
        expectedRevision: chat.headRevision,
        expectedSettingsRevision: chat.settingsRevision,
        idempotencyKey: 'evaluation-snapshot',
      },
      (current) => ({
        chatId: chat.id,
        parentRevision: current.headRevision,
        settingsRevision: current.settingsRevision,
        settings: current.settings,
        request: 'Synthetic evaluation snapshot',
        history: [],
        resources: store.product.resources(chat.id, captured),
        profile: captured,
      })
    ).run;
    const frozen = structuredClone(run.snapshot);
    const updated = store.product.model(
      modelBody(c, { expectedRevision: selected.revision }),
      selected.id
    ) as ModelPreset;
    expect(updated).not.toHaveProperty('evaluationTools');
    expect(store.product.get('model', selected.id)).toEqual(updated);
    expect(() => store.product.get('model', selected.id, selected.revision)).toThrow(
      'Setting not found'
    );
    expect(store.product.snapshot(chat.id)?.models.main).not.toHaveProperty('evaluationTools');
    expect(store.run(run.id).snapshot).toEqual(frozen);
    expect(store.run(run.id).snapshot.profile?.models.main?.evaluationTools).toEqual(
      defaultEvaluationToolOptions()
    );
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS n FROM provider_settings WHERE kind='model' AND id=?")
        .get(selected.id)
    ).toEqual({ n: 1 });
    expect(() => store.product.model(modelBody(c, { sol: {} }))).toThrow();
  }
});
