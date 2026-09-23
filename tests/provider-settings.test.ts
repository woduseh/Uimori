import { mkdtempSync, rmSync } from 'node:fs';
import { Store } from '../server/store.js';
import { observeExecutions, observedExecution } from './fixtures/execution-observer.js';
import { updateTestProfile } from './fixtures/model-workspace.js';
import { injectWithFixtureBot, createFixtureChat } from './fixtures/chat.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import {
  PROVIDER_PROTOCOLS,
  type Connection,
  type ModelPreset,
  type ProviderProtocol,
} from '../core/product.js';
import type { Run } from '../core/types.js';
import { installJevFixture, configureJevFixture } from './fixtures/jev.js';

const roots: Record<ProviderProtocol, string> = {
  'fixture-sse-v1': 'http://127.0.0.1:9/turn',
  'vertex-gemini-v1':
    'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models',
  'openai-responses-v1': 'https://api.openai.com/v1',
  'codex-app-server-v1': 'codex://local',
  'anthropic-messages-v1': 'https://api.anthropic.com/v1',
  'vercel-chat-v1': 'https://ai-gateway.vercel.sh/v1',
  'deepseek-chat-v1': 'https://api.deepseek.com/v1',
  'openai-chat-v1': 'https://synthetic.invalid/nested/v1',
};
const native = [
  'openai-responses-v1',
  'anthropic-messages-v1',
  'vercel-chat-v1',
  'openai-chat-v1',
] as const;
const env = 'My_Settings_Key';
const owned: { directory: string; app?: App }[] = [];
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('Unexpected network in synthetic settings test')
  );
  vi.stubEnv(env, 'SYNTHETIC_TEST_VALUE');
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const item of owned.splice(0).reverse()) {
    await item.app?.close();
    const target = resolve(item.directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('Uimori provider settings ')
    )
      throw new Error('Refusing cleanup outside owned test directory');
    await rm(target, { recursive: true, force: true });
  }
});
async function application(
  _approvedOrigins = [...new Set(Object.values(roots).map((value) => new URL(value).origin))]
) {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori provider settings '));
  const item: (typeof owned)[number] = { directory };
  owned.push(item);
  item.app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'provider-settings-synthetic',
    instanceId: randomUUID(),
    testMode: true,
  });
  await item.app.ready();
  observeExecutions(item.app.store);
  return item.app;
}
async function request<T = any>(
  app: App,
  path: string,
  payload: unknown,
  status = 200,
  method: 'POST' | 'PUT' = 'POST'
): Promise<T> {
  const response = await injectWithFixtureBot(app, {
    method,
    url: '/api' + path,
    payload: JSON.stringify(payload),
    headers: { host: '127.0.0.1', 'content-type': 'application/json' },
  });
  expect(response.statusCode, response.body).toBe(status);
  return response.json() as T;
}
const connectionBody = (protocol: ProviderProtocol, changes: Record<string, unknown> = {}) => ({
  title: 'Synthetic ' + protocol,
  protocol,
  endpoint: roots[protocol],
  enabled: true,
  ...changes,
});
const modelBody = (connection: Connection, changes: Record<string, unknown> = {}) => ({
  title: 'Synthetic model',
  connectionId: connection.id,
  modelId:
    connection.protocol === 'vertex-gemini-v1'
      ? 'gemini-3.8-flash'
      : connection.protocol === 'anthropic-messages-v1'
        ? 'claude-opus-5'
        : connection.protocol === 'openai-responses-v1'
          ? 'gpt-5.6-sol'
          : 'provider/model-with-editable-id',
  maxOutputTokens: 8192,
  temperature: null,
  ...changes,
});
const ref = ({ id }: { id: string }) => ({ id });
const saved = (value: Connection, changes: Record<string, unknown> = {}) =>
  connectionBody(value.protocol, {
    title: value.title,
    endpoint: value.endpoint,
    ...(value.credentialRef ? { credentialRef: value.credentialRef } : {}),
    enabled: value.enabled,
    expectedRevision: value.revision,
    ...changes,
  });
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

describe('provider settings, catalogs and archive contracts', () => {
  test('preserves absent native options, explicit false and protocol-specific generation settings', async () => {
    const app = await application();
    for (const protocol of native) {
      const connection = await request<Connection>(app, '/connections', connectionBody(protocol));
      const defaults = await request<ModelPreset>(app, '/model-presets', modelBody(connection));
      for (const key of [
        'structuredOutput',
        'reasoningEffort',
        'thinkingMode',
        'thinkingBudgetTokens',
        'thinkingLevel',
        'timeoutMs',
      ])
        expect(defaults).not.toHaveProperty(key);
      const options =
        protocol === 'anthropic-messages-v1'
          ? {
              structuredOutput: false,
              outputEffort: 'high',
              thinkingMode: 'adaptive',
              serviceTier: 'standard_only',
              timeoutMs: 1800000,
            }
          : { structuredOutput: false, reasoningEffort: 'xhigh', timeoutMs: 1800000 };
      expect(await request(app, '/model-presets', modelBody(connection, options))).toMatchObject(
        options
      );
    }
    const fixture = await request<Connection>(
      app,
      '/connections',
      connectionBody('fixture-sse-v1')
    );
    expect(
      await request(
        app,
        '/model-presets',
        modelBody(fixture, { thinkingLevel: 'HIGH', timeoutMs: 600000 })
      )
    ).toMatchObject({ thinkingLevel: 'HIGH', timeoutMs: 600000 });
    await request(app, '/model-presets', modelBody(fixture, { timeoutMs: 600001 }), 400);
    const vertex = await request<Connection>(
      app,
      '/connections',
      connectionBody('vertex-gemini-v1')
    );
    expect(
      await request(app, '/model-presets', modelBody(vertex, { timeoutMs: 1800000 }))
    ).toMatchObject({ timeoutMs: 1800000 });
  });

  test('stores an optional host input limit separately from provider generation options', async () => {
    const app = await application(),
      connection = await request<Connection>(app, '/connections', connectionBody('openai-chat-v1'));
    const defaults = await request<ModelPreset>(app, '/model-presets', modelBody(connection));
    expect(defaults).not.toHaveProperty('inputTokenLimit');
    for (const inputTokenLimit of [8192, 272000, 1000000]) {
      const model = await request<ModelPreset>(
        app,
        '/model-presets',
        modelBody(connection, { inputTokenLimit })
      );
      expect(model.inputTokenLimit).toBe(inputTokenLimit);
      expect(app.store.product.modelSnapshot(model.id).inputTokenLimit).toBe(inputTokenLimit);
    }
    for (const inputTokenLimit of [8191, 1000001, 8192.5, null, '272000', false])
      await request(app, '/model-presets', modelBody(connection, { inputTokenLimit }), 400);
    expect(app.store.product.all('model')).toHaveLength(4);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('stores Vercel providerOptions and freezes them in a model snapshot', async () => {
    const app = await application();
    const connection = await request<Connection>(
      app,
      '/connections',
      connectionBody('vercel-chat-v1')
    );
    const providerOptions = {
      gateway: { only: ['openai'], order: ['openai', 'bedrock'] },
      provider: { compatibility: 'strict' },
    };
    const model = await request<ModelPreset>(
      app,
      '/model-presets',
      modelBody(connection, {
        modelId: 'openai/gpt-5.6-sol',
        modelFamily: 'openai',
        displayOrder: 200,
        providerOptions,
      })
    );
    expect(model).toMatchObject({ modelFamily: 'openai', displayOrder: 200, providerOptions });
    expect(app.store.product.modelSnapshot(model.id)).toMatchObject({
      modelFamily: 'openai',
      providerOptions,
    });
    await request(
      app,
      '/model-presets',
      modelBody(connection, {
        modelId: 'openai/gpt-5.6-sol',
        providerOptions: { gateway: { apiKey: 'must-not-save' } },
      }),
      400
    );
  });

  test('rejects cross-provider options and inconsistent thinking budgets without storing a model', async () => {
    const app = await application();
    for (const protocol of PROVIDER_PROTOCOLS) {
      const connection = await request<Connection>(app, '/connections', connectionBody(protocol));
      const forbidden =
        protocol === 'fixture-sse-v1' || protocol === 'vertex-gemini-v1'
          ? [
              { structuredOutput: true },
              { reasoningEffort: 'high' },
              { thinkingMode: 'disabled' },
              { thinkingBudgetTokens: 2048 },
            ]
          : protocol === 'anthropic-messages-v1'
            ? [
                { thinkingLevel: 'HIGH' },
                { reasoningEffort: 'none' },
                { reasoningEffort: 'minimal' },
                { temperature: 1.1 },
                { thinkingMode: 'enabled' },
                { thinkingMode: 'enabled', thinkingBudgetTokens: 8192 },
                { thinkingMode: 'enabled', thinkingBudgetTokens: 1023 },
                { thinkingMode: 'adaptive', thinkingBudgetTokens: 2048 },
                { thinkingBudgetTokens: 2048 },
                { thinkingMode: 'enabled', thinkingBudgetTokens: 2048, temperature: 1 },
                { thinkingMode: 'adaptive', temperature: 0 },
              ]
            : protocol === 'vercel-chat-v1'
              ? [{ thinkingBudgetTokens: 2048 }]
              : [
                  { thinkingLevel: 'HIGH' },
                  { thinkingMode: 'disabled' },
                  { thinkingBudgetTokens: 2048 },
                ];
      for (const changes of [
        ...forbidden,
        ...(protocol === 'vercel-chat-v1'
          ? []
          : [{ providerOptions: { gateway: { only: ['openai'] } } }]),
        { structuredOutput: null },
        { structuredOutput: 1 },
        { reasoningEffort: 'ultra' },
        { thinkingMode: 'on' },
        { timeoutMs: 1800001 },
        { timeoutMs: null },
        { maxOutputTokens: 500001 },
        { temperature: '1' },
      ])
        await request(app, '/model-presets', modelBody(connection, changes), 400);
    }
    expect(app.store.product.all('model')).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('gateway options do not require a model family or duplicate the UI profile allowlist', async () => {
    const app = await application();
    const connection = await request<Connection>(
      app,
      '/connections',
      connectionBody('vercel-chat-v1')
    );
    for (const changes of [
      { topP: 0.8, stopSequences: ['END'] },
      { outputEffort: 'max', thinkingMode: 'adaptive' },
      { thinkingLevel: 'HIGH' },
      { modelFamily: 'xai', reasoningEffort: 'xhigh' },
    ]) {
      const model = await request<ModelPreset>(
        app,
        '/model-presets',
        modelBody(connection, changes)
      );
      expect(model).toMatchObject(changes);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  test('moving a model changes only display order, is atomic and survives a pre-existing edit', async () => {
    const app = await application();
    const connection = await request<Connection>(
      app,
      '/connections',
      connectionBody('openai-responses-v1')
    );
    const models = await Promise.all(
      ['Alpha', 'Beta', 'Gamma'].map((title) =>
        request<ModelPreset>(
          app,
          '/model-presets',
          modelBody(connection, { title, reasoningEffort: 'high' })
        )
      )
    );
    const [alpha, beta] = models;
    const snapshots = models.map((model) => app.store.product.modelSnapshot(model.id));
    expect(await request(app, `/model-presets/${alpha.id}/move`, { direction: 'up' })).toEqual({
      moved: false,
    });
    await request(app, `/model-presets/${beta.id}/move`, { direction: 'up' });
    for (const original of models) {
      const { displayOrder, ...current } = app.store.product.get<ModelPreset>('model', original.id);
      expect(current).toEqual(original);
      expect(displayOrder).toBeDefined();
    }
    expect(models.map((model) => app.store.product.modelSnapshot(model.id))).toEqual(snapshots);
    const betaOrder = app.store.product.get<ModelPreset>('model', beta.id).displayOrder;
    const edited = await request<ModelPreset>(
      app,
      `/model-presets/${beta.id}`,
      modelBody(connection, { title: 'Edited Beta', expectedRevision: beta.revision }),
      200,
      'PUT'
    );
    expect(edited.displayOrder).toBe(betaOrder);
    const beforeFailure = app.store.product.all('model');
    app.store.db.exec(
      "CREATE TRIGGER fail_order BEFORE UPDATE ON provider_settings WHEN NEW.id='" +
        alpha.id +
        "' BEGIN SELECT RAISE(ABORT, 'injected ordering failure'); END"
    );
    expect(() => app.store.product.moveModel(beta.id, { direction: 'down' })).toThrow();
    expect(app.store.product.all('model')).toEqual(beforeFailure);
    app.store.db.exec('DROP TRIGGER fail_order');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('updates a single settings row with CAS and removes model and connection revision endpoints', async () => {
    const app = await application();
    const vertex = await request<Connection>(
      app,
      '/connections',
      connectionBody('vertex-gemini-v1')
    );
    const first = await request<ModelPreset>(
      app,
      '/model-presets',
      modelBody(vertex, { serviceTier: 'standard' })
    );
    const second = await request<ModelPreset>(
      app,
      '/model-presets/' + first.id,
      { ...modelBody(vertex, { serviceTier: 'flex' }), expectedRevision: first.revision },
      200,
      'PUT'
    );
    expect(second.serviceTier).toBe('flex');
    expect(app.store.product.get<ModelPreset>('model', first.id)).toEqual(second);
    expect(() => app.store.product.get('model', first.id, first.revision)).toThrow(
      'Setting not found'
    );
    expect(second).not.toHaveProperty('connectionRevision');
    expect(second.source).not.toHaveProperty('connectionRevision');
    await request(
      app,
      '/model-presets/' + first.id,
      { ...modelBody(vertex, { serviceTier: 'standard' }), expectedRevision: first.revision },
      409,
      'PUT'
    );
    expect(app.store.product.get('model', first.id)).toEqual(second);
    expect(app.store.product.authorize(vertex)).toEqual(vertex);
    const custom = await request<Connection>(app, '/connections', connectionBody('openai-chat-v1'));
    vi.mocked(fetch).mockResolvedValueOnce(response({ data: [{ id: 'old-model' }] }));
    const listed = await request<Connection>(app, `/connections/${custom.id}/catalog`, {});
    expect(listed.catalog).toHaveLength(1);
    const edited = await request<Connection>(
      app,
      '/connections/' + custom.id,
      saved(listed, { endpoint: 'https://synthetic.invalid/changed/v1' }),
      200,
      'PUT'
    );
    expect(edited.catalog).toEqual([]);
    expect(() => app.store.product.authorize(listed)).toThrow('authority changed');
    await request(
      app,
      '/connections/' + custom.id,
      saved(listed, { title: 'Stale edit' }),
      409,
      'PUT'
    );
    expect(app.store.product.get('connection', custom.id)).toEqual(edited);
    for (const [kind, setting] of [
      ['model', second],
      ['connection', edited],
    ] as const) {
      expect(
        app.store.db
          .prepare('SELECT COUNT(*) AS count FROM provider_settings WHERE kind=? AND id=?')
          .get(kind, setting.id)?.count
      ).toBe(1);
      for (const revision of [1, setting.revision]) {
        const missing = await injectWithFixtureBot(app, {
          method: 'GET',
          url: `/api/revisions/${kind}/${setting.id}/${revision}`,
          headers: { host: '127.0.0.1' },
        });
        expect(missing.statusCode).toBe(404);
      }
    }
    expect(
      app.store.db
        .prepare("SELECT COUNT(*) AS count FROM versions WHERE kind IN ('model','connection')")
        .get()?.count
    ).toBe(0);
  });

  test('an existing chat uses current model and connection settings on its next Run while its in-flight and completed snapshot stay frozen', async () => {
    const app = await application(),
      connection = await request<Connection>(
        app,
        '/connections',
        connectionBody('openai-chat-v1', { apiKey: 'SYNTHETIC_TEST_VALUE' })
      );
    const model = await request<ModelPreset>(
      app,
      '/model-presets',
      modelBody(connection, { modelId: 'synthetic-first', maxOutputTokens: 512 })
    );
    const chat = createFixtureChat(app.store, 'Mutable settings synthetic story'),
      initial = app.store.product.profile(chat.id);
    const profile = updateTestProfile(app.store.product, chat.id, {
      expectedRevision: initial.revision,
      packageAttachments: initial.packageAttachments,

      image: false,
      routes: { ...initial.routes, main: ref(model) },
    });
    const command = () => {
      const current = app.store.chat(chat.id);
      return {
        request: 'Continue the synthetic scene.',
        expectedRevision: current.headRevision,
        expectedSettingsRevision: current.settingsRevision,
        expectedProfileRevision: profile.revision,
        idempotencyKey: randomUUID(),
      };
    };
    const stream = (text: string) =>
      new Response(
        [
          {
            id: 'synthetic-chat',
            choices: [
              { index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' },
            ],
            usage: null,
          },
          { id: 'synthetic-chat', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
          '[DONE]',
        ]
          .map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
          .join(''),
        { headers: { 'content-type': 'text/event-stream' } }
      );
    let release: (() => void) | undefined, started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wire: { url: string; body: Record<string, unknown> }[] = [];
    const providerFetch = vi.mocked(fetch);
    providerFetch.mockImplementation(async (url, init) => {
      wire.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      if (wire.length === 1) {
        started();
        return new Promise<Response>((resolve) => {
          release = () => resolve(stream('The old configuration writes this synthetic sentence.'));
        });
      }
      return stream('The current configuration writes the next synthetic sentence.');
    });
    const judgments = installJevFixture();
    configureJevFixture(app.store);
    try {
      const first = await request<Run>(app, `/chats/${chat.id}/runs`, command());
      await began;
      const frozen = structuredClone(
        observedExecution(app.store, first.id).snapshot.profile!.models.main!
      );
      const editedConnection = await request<Connection>(
        app,
        `/connections/${connection.id}`,
        saved(connection, { endpoint: 'https://synthetic.invalid/changed/v1' }),
        200,
        'PUT'
      );
      const editedModel = await request<ModelPreset>(
        app,
        `/model-presets/${model.id}`,
        modelBody(editedConnection, {
          expectedRevision: model.revision,
          modelId: 'synthetic-second',
          maxOutputTokens: 1024,
          inputTokenLimit: 272000,
        }),
        200,
        'PUT'
      );
      expect(app.store.product.profile(chat.id).routes.main).toEqual({ id: model.id });
      expect(app.store.product.profile(chat.id).revision).toBe(profile.revision);
      expect(observedExecution(app.store, first.id).snapshot.profile!.models.main).toEqual(frozen);
      release!();
      await expect
        .poll(() => observedExecution(app.store, first.id).status, { timeout: 5000 })
        .toBe('completed');
      const second = await request<Run>(app, `/chats/${chat.id}/runs`, command());
      await expect
        .poll(() => observedExecution(app.store, second.id).status, { timeout: 5000 })
        .toBe('completed');
      expect(wire).toHaveLength(2);
      expect(wire[0]).toMatchObject({
        url: connection.endpoint + '/chat/completions',
        body: { model: 'synthetic-first', max_completion_tokens: 512 },
      });
      expect(wire[1]).toMatchObject({
        url: editedConnection.endpoint + '/chat/completions',
        body: { model: 'synthetic-second', max_completion_tokens: 1024 },
      });
      expect(wire[1].body).not.toHaveProperty('inputTokenLimit');
      expect(observedExecution(app.store, second.id).snapshot.profile!.models.main).toMatchObject({
        ...editedModel,
        connection: editedConnection,
      });
      expect(observedExecution(app.store, first.id).snapshot.profile!.models.main).toEqual(frozen);
      const disabled = await request<ModelPreset>(
        app,
        `/model-presets/${model.id}`,
        modelBody(editedConnection, {
          expectedRevision: editedModel.revision,
          modelId: editedModel.modelId,
          maxOutputTokens: editedModel.maxOutputTokens,
          enabled: false,
        }),
        200,
        'PUT'
      );
      await request(app, `/chats/${chat.id}/runs`, command(), 403);
      expect(providerFetch).toHaveBeenCalledTimes(2);
      expect(judgments).toHaveLength(2);
      expect(app.store.product.profile(chat.id).routes.main).toEqual({ id: disabled.id });
      expect(observedExecution(app.store, first.id).snapshot.profile!.models.main).toEqual(frozen);
    } finally {
      release?.();
    }
  });

  test('collects bounded Anthropic pages in order without exposing partial or malformed pagination', async () => {
    const app = await application();
    const connection = await request<Connection>(
      app,
      '/connections',
      connectionBody('anthropic-messages-v1', { apiKey: 'SYNTHETIC_TEST_VALUE' })
    );
    const seen: string[] = [];
    vi.mocked(fetch).mockImplementation(async (url) => {
      seen.push(String(url));
      return response(
        seen.length === 1
          ? { data: [{ id: 'first', display_name: 'First' }], has_more: true, last_id: 'first' }
          : { data: [{ id: 'second', display_name: 'Second' }], has_more: false, last_id: 'second' }
      );
    });
    const listed = await request<Connection>(app, `/connections/${connection.id}/catalog`, {});
    expect(listed.catalog.map((model) => model.id)).toEqual(['first', 'second']);
    expect(seen).toHaveLength(2);
    expect(new URL(seen[1]).searchParams.get('after_id')).toBe('first');
    vi.mocked(fetch).mockResolvedValue(
      response({ data: [{ id: 'duplicate' }], has_more: true, last_id: 'duplicate' })
    );
    const failed = await request<Connection>(app, `/connections/${connection.id}/catalog`, {});
    expect(failed.catalogError).toBe('CATALOG_UNAVAILABLE');
    expect(failed.catalog).toEqual(listed.catalog);
  });

  test('rejects unavailable registered credentials and disabled connections before catalog requests', async () => {
    const app = await application();
    for (const protocol of ['openai-responses-v1', 'anthropic-messages-v1'] as const) {
      const connection = await request<Connection>(app, '/connections', connectionBody(protocol));
      expect(await request(app, `/connections/${connection.id}/catalog`, {})).toMatchObject({
        catalogError: 'CATALOG_UNAVAILABLE',
        catalog: [],
      });
    }
    const disabled = await request<Connection>(
      app,
      '/connections',
      connectionBody('vercel-chat-v1', { enabled: false })
    );
    expect(await request(app, `/connections/${disabled.id}/catalog`, {})).toMatchObject({
      catalogError: 'CATALOG_UNAVAILABLE',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('retains old catalog data for HTTP, schema, encoding and size errors', async () => {
    const app = await application();
    const connection = await request<Connection>(
      app,
      '/connections',
      connectionBody('openai-chat-v1')
    );
    vi.mocked(fetch).mockResolvedValueOnce(response({ data: [{ id: 'kept' }] }));
    const listed = await request<Connection>(app, `/connections/${connection.id}/catalog`, {});
    for (const bad of [
      new Response('SYNTHETIC_NOT_SECRET', { status: 401 }),
      response({ models: [] }),
      response({ data: [{ id: 'duplicate' }, { id: 'duplicate' }] }),
      response({ data: [{ id: 1 }] }),
      new Response(new Uint8Array([0xff])),
      new Response(' '.repeat(1000001)),
    ]) {
      vi.mocked(fetch).mockResolvedValueOnce(bad);
      const failed = await request<Connection>(app, `/connections/${connection.id}/catalog`, {});
      expect(failed.catalog).toEqual(listed.catalog);
      expect(failed.catalogError).toBe('CATALOG_UNAVAILABLE');
      expect(JSON.stringify(failed)).not.toContain('SYNTHETIC_NOT_SECRET');
    }
  });

  test('does not overwrite newer connection settings when an older catalog response arrives', async () => {
    const app = await application();
    const connection = await request<Connection>(
      app,
      '/connections',
      connectionBody('openai-chat-v1')
    );
    let accept!: (value: Response) => void, started!: () => void;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(fetch).mockImplementation(() => {
      started();
      return new Promise((resolve) => {
        accept = resolve;
      });
    });
    const refresh = request(app, `/connections/${connection.id}/catalog`, {}, 409);
    await begun;
    const edited = await request<Connection>(
      app,
      '/connections/' + connection.id,
      saved(connection, { title: 'User edited title', enabled: false }),
      200,
      'PUT'
    );
    accept(response({ data: [{ id: 'late-model' }] }));
    await refresh;
    expect(app.store.product.get('connection', connection.id)).toEqual(edited);
  });
});

describe('Current revision retrieval', () => {
  const owners: { directory: string; store: Store; app?: App }[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const owner of owners.splice(0)) {
      if (owner.app) await owner.app.close();
      else owner.store.close();
      rmSync(owner.directory, { recursive: true, force: true });
    }
  });

  async function application() {
    const directory = mkdtempSync(join(tmpdir(), 'uimori-retention-'));
    const app = await createApp({
      dbPath: join(directory, 'app.sqlite'),
      buildId: 'extended-cleanup-test',
      testMode: true,
      codex: { enabled: false },
    });
    owners.push({ directory, store: app.store, app });
    return app;
  }

  test('provider/model conflict recovery can retrieve the current revision without returning API keys', async () => {
    const app = await application();
    const connection = app.store.product.connection({
      title: 'Current provider',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9',
      enabled: true,
    });
    const model = app.store.product.model({
      title: 'Current model',
      connectionId: connection.id,
      modelId: 'synthetic',
      temperature: null,
      maxOutputTokens: 1024,
    });
    for (const [route, item] of [
      ['connections', connection],
      ['model-presets', model],
    ] as const) {
      const response = await app.inject({ url: `/api/${route}/${item.id}` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: item.id,
        title: item.title,
        revision: item.revision,
      });
      expect(response.json()).not.toHaveProperty('apiKey');
    }
  });
});
