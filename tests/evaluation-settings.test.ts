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
import { modelDraft, modelPayload } from '../web/provider-model-draft.js';

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
    metadataProfile: 'neutral',
    approvalReasoningMode: 'configured',
    maximumToolRounds: 8,
    terminalLateCorrections: false,
  });
  expect(validateEvaluationToolOptions(defaults)).toEqual(defaults);
  expect(validateEvaluationToolOptions({ ...defaults, contextMode: 'source-bound' })).toMatchObject(
    {
      contextMode: 'source-bound',
    }
  );
  for (const invalid of [
    undefined,
    null,
    {},
    { ...defaults, maximumToolRounds: 33 },
    { ...defaults, maximumToolRounds: -1 },
    { ...defaults, contextMode: 'unknown' },
    { ...defaults, metadataProfile: 'unknown' },
    { ...defaults, outputRecovery: undefined },
    { ...defaults, outputRecovery: 'true' },
    { ...defaults, serviceTier: 'flex' },
    { ...defaults, extra: true },
  ])
    expect(() => validateEvaluationToolOptions(invalid)).toThrow('INVALID_EVALUATION_TOOL_OPTIONS');
  for (const outputRecovery of [true, false])
    expect(
      validateEvaluationToolOptions({ ...defaults, maximumToolRounds: 0, outputRecovery })
    ).toEqual({ ...defaults, maximumToolRounds: 0 });
  const { metadataProfile: _metadataProfile, ...legacy } = defaults;
  expect(validateEvaluationToolOptions(legacy)).toEqual(legacy);
  expect(validateEvaluationToolOptions({ ...legacy, outputRecovery: true })).toEqual(legacy);
});

test('editing a legacy preset drops retired refusal controls without rewriting the original', () => {
  const store = database(),
    c = connection(store),
    model = store.product.model(modelBody(c)) as ModelPreset;
  const { metadataProfile: _metadataProfile, ...legacy } = defaultEvaluationToolOptions();
  const saved = { ...model, evaluationTools: { ...legacy, outputRecovery: true } };
  const draft = modelDraft(saved);
  expect(draft.evaluationTools).not.toHaveProperty('outputRecovery');
  expect(modelPayload(draft, c).evaluationTools).toEqual({ ...legacy, metadataProfile: 'neutral' });
  expect(saved.evaluationTools).toEqual({ ...legacy, outputRecovery: true });
});

test('fresh snapshots opt legacy presets into metadata selection without rewriting saved settings', () => {
  const store = database();
  const { metadataProfile: _metadataProfile, ...legacy } = defaultEvaluationToolOptions();
  for (const protocol of [
    'openai-responses-v1',
    'anthropic-messages-v1',
    'openai-chat-v1',
  ] as const) {
    const c = connection(store, protocol);
    const model = store.product.model(modelBody(c, { evaluationTools: legacy })) as ModelPreset;
    const captured = store.product.modelSnapshot(model.id);
    expect(captured.evaluationTools).toEqual({ ...legacy, metadataProfile: 'neutral' });
    expect(captured.connection.protocol).toBe(protocol);
    expect(store.product.get<ModelPreset>('model', model.id).evaluationTools).toEqual(legacy);
    store.product.model(
      modelBody(c, {
        expectedRevision: model.revision,
        evaluationTools: { ...legacy, metadataProfile: 'deepmind' },
      }),
      model.id
    );
    expect(store.product.modelSnapshot(model.id).evaluationTools?.metadataProfile).toBe('deepmind');
    expect(captured.evaluationTools?.metadataProfile).toBe('neutral');
  }
});

test('only selected model presets persist evaluation tools and captured runs retain earlier settings', () => {
  const store = database();
  for (const protocol of ['openai-responses-v1', 'anthropic-messages-v1'] as const) {
    const c = connection(store, protocol),
      disabled = store.product.model(modelBody(c)) as ModelPreset;
    expect(disabled).not.toHaveProperty('evaluationTools');
    const options = {
      ...defaultEvaluationToolOptions(),
      ...(protocol === 'anthropic-messages-v1' ? { contextMode: 'source-bound' as const } : {}),
    };
    const selected = store.product.model(modelBody(c, { evaluationTools: options })) as ModelPreset;
    expect(selected.evaluationTools).toEqual(options);
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
    expect(store.run(run.id).snapshot.profile?.models.main?.evaluationTools).toEqual(options);
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS n FROM provider_settings WHERE kind='model' AND id=?")
        .get(selected.id)
    ).toEqual({ n: 1 });
    expect(() => store.product.model(modelBody(c, { sol: {} }))).toThrow();
  }
});
