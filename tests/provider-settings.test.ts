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
import type { Run, RunSnapshot } from '../core/types.js';

const roots: Record<ProviderProtocol, string> = {
  'fixture-sse-v1': 'http://127.0.0.1:9/turn',
  'vertex-gemini-v1':
    'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models',
  'openai-responses-v1': 'https://api.openai.com/v1',
  'codex-app-server-v1': 'codex://local',
  'anthropic-messages-v1': 'https://api.anthropic.com/v1',
  'vercel-chat-v1': 'https://ai-gateway.vercel.sh/v1',
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
  approvedOrigins = [...new Set(Object.values(roots).map((value) => new URL(value).origin))]
) {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori provider settings '));
  const item: (typeof owned)[number] = { directory };
  owned.push(item);
  item.app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'provider-settings-synthetic',
    instanceId: randomUUID(),
    testMode: true,
    approvedOrigins,
  });
  await item.app.ready();
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
    ...(value.credentialEnv ? { credentialEnv: value.credentialEnv } : {}),
    enabled: value.enabled,
    expectedRevision: value.revision,
    ...changes,
  });
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

describe('provider settings, catalogs and archive contracts', () => {
  test('saves supported protocols and enforces endpoints, general credential names and Vertex-only tiers', async () => {
    const app = await application();
    for (const protocol of PROVIDER_PROTOCOLS) {
      const connection = await request<Connection>(
        app,
        '/connections',
        connectionBody(protocol, {
          endpoint: roots[protocol] + (protocol === 'codex-app-server-v1' ? '' : '/'),
        })
      );
      expect(connection.protocol).toBe(protocol);
      expect(connection).not.toHaveProperty('credentialEnv');
      expect(connection.endpoint).toBe(
        protocol === 'fixture-sse-v1' ? roots[protocol] + '/' : roots[protocol]
      );
      expect(connection).not.toHaveProperty('requestTier');
    }
    for (const protocol of native) {
      await request(app, '/connections', connectionBody(protocol, { requestTier: 'flex' }), 400);
      await request(
        app,
        '/connections',
        connectionBody(protocol, { endpoint: roots[protocol] + '?api_key=synthetic' }),
        400
      );
      for (const credentialEnv of [null, false, 5, 'INVALID-NAME', '1KEY', 'A'.repeat(201)])
        await request(app, '/connections', connectionBody(protocol, { credentialEnv }), 400);
      for (const credentialEnv of ['OPENAI_API_KEY', 'myGatewayToken', '_CUSTOM_2'])
        expect(
          await request<Connection>(
            app,
            '/connections',
            connectionBody(protocol, { credentialEnv })
          )
        ).toHaveProperty('credentialEnv', credentialEnv);
    }
    expect(
      (
        await request<Connection>(
          app,
          '/connections',
          connectionBody('openai-responses-v1', { endpoint: 'https://synthetic.invalid/v1' })
        )
      ).endpoint
    ).toBe('https://synthetic.invalid/v1');
    for (const protocol of ['anthropic-messages-v1', 'vercel-chat-v1'] as const) {
      await request(
        app,
        '/connections',
        connectionBody(protocol, { endpoint: 'https://synthetic.invalid/v1' }),
        400
      );
      await request(
        app,
        '/connections',
        connectionBody(protocol, { endpoint: roots[protocol] + '/wrong' }),
        400
      );
    }
    await request(
      app,
      '/connections',
      connectionBody('openai-chat-v1', { endpoint: 'http://not-loopback.invalid/v1' }),
      400
    );
    await request(
      app,
      '/connections',
      connectionBody('openai-chat-v1', { endpoint: 'http://127.0.0.1:9999/v1', credentialEnv: env })
    );
    for (const requestTier of [null, 'auto', 'priority', 1])
      await request(app, '/connections', connectionBody('vertex-gemini-v1', { requestTier }), 400);
    expect(fetch).not.toHaveBeenCalled();
  });

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
            : [
                { thinkingLevel: 'HIGH' },
                { thinkingMode: 'disabled' },
                { thinkingBudgetTokens: 2048 },
              ];
      for (const changes of [
        ...forbidden,
        { structuredOutput: null },
        { structuredOutput: 1 },
        { reasoningEffort: 'ultra' },
        { thinkingMode: 'on' },
        { timeoutMs: 1800001 },
        { timeoutMs: null },
        { maxOutputTokens: 200001 },
        { temperature: '1' },
      ])
        await request(app, '/model-presets', modelBody(connection, changes), 400);
    }
    expect(app.store.product.all('model')).toEqual([]);
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
        connectionBody('openai-chat-v1', { credentialEnv: env })
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
      attachments: initial.attachments,

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
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      wire.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      if (wire.length === 1) {
        started();
        return new Promise<Response>((resolve) => {
          release = () => resolve(stream('The old configuration writes this synthetic sentence.'));
        });
      }
      return stream('The current configuration writes the next synthetic sentence.');
    });
    try {
      const first = await request<Run>(app, `/chats/${chat.id}/runs`, command());
      await began;
      const frozen = structuredClone(app.store.run(first.id).snapshot.profile!.models.main!);
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
      expect(app.store.run(first.id).snapshot.profile!.models.main).toEqual(frozen);
      release!();
      await expect.poll(() => app.store.run(first.id).status, { timeout: 5000 }).toBe('completed');
      const second = await request<Run>(app, `/chats/${chat.id}/runs`, command());
      await expect.poll(() => app.store.run(second.id).status, { timeout: 5000 }).toBe('completed');
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
      expect(app.store.run(second.id).snapshot.profile!.models.main).toEqual({
        ...editedModel,
        connection: editedConnection,
      });
      expect(app.store.run(first.id).snapshot.profile!.models.main).toEqual(frozen);
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
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(app.store.product.profile(chat.id).routes.main).toEqual({ id: disabled.id });
      expect(app.store.run(first.id).snapshot.profile!.models.main).toEqual(frozen);
    } finally {
      release?.();
    }
  });

  test('archives a model against its saved capability protocol even after its current connection protocol changes', async () => {
    const source = await application(),
      connection = await request<Connection>(
        source,
        '/connections',
        connectionBody('openai-responses-v1')
      );
    const model = await request<ModelPreset>(
      source,
      '/model-presets',
      modelBody(connection, { reasoningEffort: 'high', inputTokenLimit: 272000 })
    );
    const changed = await request<Connection>(
      source,
      `/connections/${connection.id}`,
      connectionBody('anthropic-messages-v1', { expectedRevision: connection.revision }),
      200,
      'PUT'
    );
    expect(model.capabilityProtocol).toBe('openai-responses-v1');
    expect(() => source.store.product.modelSnapshot(model.id)).toThrow(
      'Connection protocol changed'
    );
    const archive = source.store.product.export(),
      target = await application();
    expect(target.store.product.import(archive)).toMatchObject({ restored: true });
    expect(target.store.product.get('model', model.id)).toEqual(model);
    const restored = target.store.product.get<Connection>('connection', changed.id);
    expect(restored).toMatchObject({ protocol: 'anthropic-messages-v1', enabled: false });
    const enabled = await request<Connection>(
      target,
      `/connections/${restored.id}`,
      saved(restored, { enabled: true }),
      200,
      'PUT'
    );
    expect(() => target.store.product.modelSnapshot(model.id)).toThrow(
      'Connection protocol changed'
    );
    const reviewed = await request<ModelPreset>(
      target,
      `/model-presets/${model.id}`,
      modelBody(enabled, { expectedRevision: model.revision, outputEffort: 'high' }),
      200,
      'PUT'
    );
    expect(reviewed).toMatchObject({
      id: model.id,
      capabilityProtocol: 'anthropic-messages-v1',
      modelId: 'claude-opus-5',
    });
    expect(target.store.product.modelSnapshot(model.id)).toEqual({
      ...reviewed,
      connection: enabled,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('reads native catalogs using their exact base path and auth headers while retaining unknown capabilities and pricing', async () => {
    const app = await application();
    for (const protocol of native) {
      const credentialEnv =
        protocol === 'vercel-chat-v1' || protocol === 'openai-chat-v1' ? undefined : env;
      const connection = await request<Connection>(
        app,
        '/connections',
        connectionBody(protocol, { credentialEnv })
      );
      vi.mocked(fetch).mockResolvedValueOnce(
        response({
          data: [
            {
              id: 'synthetic-model',
              display_name: 'Synthetic label',
              capabilities: { tools: true },
              pricing: { input: '0.1' },
            },
          ],
          has_more: false,
        })
      );
      const result = await request<Connection>(app, `/connections/${connection.id}/catalog`, {});
      expect(result.catalogError).toBeNull();
      expect(result.catalog).toEqual([
        {
          id: 'synthetic-model',
          name: 'Synthetic label',
          capabilities: { tools: null, structuredOutput: null },
          priceRevision: null,
        },
      ]);
      const [url, init] = vi.mocked(fetch).mock.calls.at(-1)!;
      const address = new URL(String(url));
      expect(address.origin + address.pathname).toBe(roots[protocol] + '/models');
      expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
      const headers = new Headers(init?.headers);
      if (protocol === 'anthropic-messages-v1') {
        expect(headers.get('x-api-key')).toBe('SYNTHETIC_TEST_VALUE');
        expect(headers.get('anthropic-version')).toBe('2023-06-01');
        expect(address.searchParams.get('limit')).toBe('1000');
        expect(headers.has('authorization')).toBe(false);
      } else
        expect(headers.get('authorization')).toBe(
          credentialEnv ? 'Bearer SYNTHETIC_TEST_VALUE' : null
        );
      expect(JSON.stringify(result)).not.toContain('SYNTHETIC_TEST_VALUE');
    }
  });

  test('collects bounded Anthropic pages in order without exposing partial or malformed pagination', async () => {
    const app = await application();
    const connection = await request<Connection>(
      app,
      '/connections',
      connectionBody('anthropic-messages-v1', { credentialEnv: env })
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

  test('rejects missing credentials, disabled connections and unapproved origins before any catalog request', async () => {
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
    const unapprovedApp = await application([]);
    const unapproved = await request<Connection>(
      unapprovedApp,
      '/connections',
      connectionBody('openai-chat-v1', { credentialEnv: env })
    );
    expect(await request(unapprovedApp, `/connections/${unapproved.id}/catalog`, {})).toMatchObject(
      { catalogError: 'CATALOG_UNAVAILABLE' }
    );
    vi.stubEnv(env, 'synthetic\r\nnot-a-header');
    const invalid = await request<Connection>(
      app,
      '/connections',
      connectionBody('openai-chat-v1', { credentialEnv: env })
    );
    expect(await request(app, `/connections/${invalid.id}/catalog`, {})).toMatchObject({
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

  test('restores current native settings independently from frozen run settings while removing credentials and disabling connections', async () => {
    const source = await application();
    const product = source.store.product;
    const models: ModelPreset[] = [];
    const connections: Connection[] = [];
    for (const protocol of native) {
      const connection = await request<Connection>(
        source,
        '/connections',
        connectionBody(protocol, { credentialEnv: env })
      );
      connections.push(connection);
      models.push(
        await request<ModelPreset>(
          source,
          '/model-presets',
          modelBody(connection, {
            structuredOutput: false,
            timeoutMs: 1800000,
            ...(protocol === 'anthropic-messages-v1'
              ? { outputEffort: 'high', thinkingMode: 'adaptive', serviceTier: 'auto' }
              : {
                  reasoningEffort: 'high',
                  ...(protocol === 'openai-responses-v1'
                    ? {
                        serviceTier: 'flex',
                        verbosity: 'low',
                        reasoningMode: 'pro',
                        reasoningContext: 'all_turns',
                      }
                    : {}),
                }),
          })
        )
      );
    }
    const vertex = await request<Connection>(
      source,
      '/connections',
      connectionBody('vertex-gemini-v1', { credentialEnv: env })
    );
    const chat = createFixtureChat(source.store, 'Synthetic provider snapshot');
    const initial = product.profile(chat.id);
    const profile = updateTestProfile(product, chat.id, {
      expectedRevision: initial.revision,
      attachments: [],

      routes: {
        main: ref(models[0]),
        translation: ref(models[1]),
        status: ref(models[2]),
        image: ref(models[3]),
      },
      image: false,
    });
    const captured = product.snapshot(chat.id)!;
    const prompt = 'Synthetic snapshot without provider execution';
    const run = source.store.createRun(
      chat.id,
      {
        request: prompt,
        expectedRevision: null,
        expectedSettingsRevision: chat.settingsRevision,
        expectedProfileRevision: profile.revision,
        idempotencyKey: randomUUID(),
      },
      (current) =>
        ({
          chatId: chat.id,
          parentRevision: null,
          settingsRevision: current.settingsRevision,
          settings: current.settings,
          request: prompt,
          history: [],
          resources: product.resources(chat.id, captured),
          profile: captured,
        }) satisfies RunSnapshot
    ).run;
    await request(
      source,
      '/model-presets/' + models[0].id,
      {
        ...modelBody(connections[0], {
          structuredOutput: true,
          reasoningEffort: 'low',
          timeoutMs: 1,
        }),
        expectedRevision: models[0].revision,
      },
      200,
      'PUT'
    );
    const archive = product.export();
    const original = JSON.stringify(archive);
    const target = await application();
    expect(target.store.product.import(archive)).toMatchObject({ restored: true, chats: 1 });
    expect(JSON.stringify(archive)).toBe(original);
    for (const model of models)
      expect(target.store.product.get('model', model.id)).toEqual(product.get('model', model.id));
    expect(() => target.store.product.get('model', models[0].id, models[0].revision)).toThrow(
      'Setting not found'
    );
    expect(
      target.store.db
        .prepare("SELECT COUNT(*) AS count FROM provider_settings WHERE kind='model'")
        .get()?.count
    ).toBe(models.length);
    const frozen = target.store.run(run.id).snapshot.profile!;
    expect(frozen.models.main).toMatchObject({
      structuredOutput: false,
      reasoningEffort: 'high',
      timeoutMs: 1800000,
    });
    expect(frozen.models.translation).toMatchObject({
      thinkingMode: 'adaptive',
      outputEffort: 'high',
      serviceTier: 'auto',
    });
    for (const model of Object.values(frozen.models)) {
      expect(model!.connection.enabled).toBe(false);
      expect(model!.connection).not.toHaveProperty('credentialEnv');
    }
    expect(target.store.product.get<Connection>('connection', vertex.id)).toMatchObject({
      enabled: false,
    });
    expect(target.store.product.get('model', models[0].id)).toMatchObject({
      revision: 2,
      structuredOutput: true,
      reasoningEffort: 'low',
      timeoutMs: 1,
    });
    expect(target.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('validates archived current provider settings against their connection protocol and rolls back forged archives', async () => {
    for (const protocol of native) {
      const source = await application();
      const connection = await request<Connection>(
        source,
        '/connections',
        connectionBody(protocol)
      );
      await request(source, '/model-presets', modelBody(connection));
      const archive = source.store.product.export();
      for (const kind of ['model', 'connection']) {
        const forged = structuredClone(archive);
        const row = forged.tables.provider_settings.find((row) => row.kind === kind)!;
        row.body = JSON.stringify({
          ...JSON.parse(row.body),
          ...(kind === 'model' ? { thinkingLevel: 'HIGH' } : { requestTier: 'flex' }),
        });
        const original = JSON.stringify(forged);
        const target = await application();
        expect(() => target.store.product.import(forged)).toThrow();
        expect(JSON.stringify(forged)).toBe(original);
        expect(target.store.product.library()).toMatchObject({
          connections: [],
          models: [],
          contents: [],
        });
        expect(target.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      }
    }
  });

  test('saves Fable, cache modes and pending IDs while rejecting invalid combinations and missing archive capability revisions', async () => {
    const app = await application(),
      connection = await request<Connection>(
        app,
        '/connections',
        connectionBody('anthropic-messages-v1')
      );
    const body = modelBody(connection, {
      modelId: 'claude-fable-5-1',
      outputEffort: 'max',
      thinkingMode: 'adaptive',
      cacheMode: 'automatic',
      cacheTtl: '1h',
    });
    const model = await request<ModelPreset>(app, '/model-presets', body);
    expect(model).toMatchObject({
      outputEffort: 'max',
      thinkingMode: 'adaptive',
      cacheMode: 'automatic',
      cacheTtl: '1h',
      capabilityRevision: expect.any(String),
    });
    for (const change of [
      { thinkingMode: 'disabled' },
      { reasoningEffort: 'high' },
      { cacheMode: 'disabled' },
      {
        evaluationTools: {
          contextMode: 'preloaded',
          approvalReasoningMode: 'configured',
          maximumToolRounds: 8,
          terminalLateCorrections: false,
          outputRecovery: true,
        },
      },
    ])
      await request(app, '/model-presets', { ...body, ...change }, 400);
    const pending = await request<ModelPreset>(
      app,
      '/model-presets',
      modelBody(connection, { modelId: 'unreviewed-new-model' })
    );
    expect(pending).not.toHaveProperty('capabilityRevision');
    const archive = app.store.product.export();
    for (const revision of [undefined, 'unreviewed-revision']) {
      const forged = structuredClone(archive),
        row = forged.tables.provider_settings.find(
          (row) => row.kind === 'model' && row.id === model.id
        )!;
      row.body = JSON.stringify({ ...JSON.parse(row.body), capabilityRevision: revision });
      const target = await application(),
        before = JSON.stringify(forged);
      expect(() => target.store.product.import(forged)).toThrow(
        'MODEL_CAPABILITY_REVISION_MISMATCH'
      );
      expect(JSON.stringify(forged)).toBe(before);
      expect(target.store.product.all('model')).toEqual([]);
    }
    const target = await application();
    expect(target.store.product.import(archive)).toMatchObject({ restored: true });
    expect(target.store.product.get('model', model.id)).toEqual(model);
    expect(fetch).not.toHaveBeenCalled();
  });
});
