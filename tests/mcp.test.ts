import { afterEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitSource } from '../core/auxiliary.js';
import { editableResource } from '../core/resource-editing.js';
import { createApp, type App } from '../server/app.js';
import { deleteChat } from '../server/chat-deletion.js';
import { fontCatalog, registerFont } from '../server/fonts.js';
import { listIllustrationCuts } from '../server/helper-illustration-cuts.js';
import { generateHelperIllustrations } from '../server/helper-illustration-generation.js';
import { cancelIllustration, updateIllustrationSettings } from '../server/illustrations.js';
import { deleteLibraryItem } from '../server/library-deletion.js';
import { setMaintenance } from '../server/maintenance.js';
import { MCP_DELETE_SETTING, MCP_READ_TOKEN_BUDGET } from '../server/mcp-tools.js';
import { mcpToken as checkedMcpToken } from '../server/network-policy.js';
import {
  modelWorkspace,
  promptWorkspace,
  updateModelWorkspace,
} from '../server/prompt-workspace.js';
import { paletteCatalog, savePalette } from '../server/themes.js';
import type { Content, ModelPreset } from '../core/product.js';
import { countTextTokens } from '../core/text-tokens.js';
import { createFixtureChat, fixtureBotInput, injectWithFixtureBot } from './fixtures/chat.js';
import { chatWithSource, fixtureSettings } from './fixtures/illustration.js';
import { messages as settingsMessages } from '../web/locales/settings.js';
import { updateTestProfile } from './fixtures/model-workspace.js';

const host = 'story.example.test';
const origin = `https://${host}`;
const accessToken = 'synthetic-access-token-for-mcp-tests-0000';
const mcpToken = 'synthetic-mcp-token-for-mcp-tests-00000000';
const bearer = { host, authorization: `Bearer ${mcpToken}` };
const MODERN = '2026-07-28';
const meta = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientCapabilities': {},
};

const apps: App[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function app(options: { mcpToken?: string; selfHost?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-mcp-'));
  directories.push(directory);
  const created = await createApp({
    dbPath: join(directory, 'app.sqlite'),
    buildId: 'synthetic-mcp',
    ...(options.selfHost === false ? { testMode: true } : { accessToken, publicOrigin: origin }),
    ...(options.mcpToken === undefined ? {} : { mcpToken: options.mcpToken }),
  });
  apps.push(created);
  return created;
}

let nextId = 1;
function post(
  target: App,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = bearer
) {
  return target.inject({
    method: 'POST',
    url: '/api/mcp',
    headers,
    payload: { jsonrpc: '2.0', id: nextId++, method, params },
  });
}
function modern(
  target: App,
  method: string,
  params: Record<string, unknown> = {},
  requestHost = host
) {
  const name = params.name ?? params.uri;
  return post(
    target,
    method,
    { ...params, _meta: meta },
    {
      ...bearer,
      host: requestHost,
      'mcp-protocol-version': MODERN,
      'mcp-method': method,
      ...(typeof name === 'string' ? { 'mcp-name': name } : {}),
    }
  );
}
async function call(target: App, name: string, args: Record<string, unknown>, requestHost = host) {
  const response = await modern(target, 'tools/call', { name, arguments: args }, requestHost);
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json().result;
  return { isError: result.isError === true, value: JSON.parse(result.content[0].text) };
}

test('only the dedicated bearer token opens the MCP endpoint, and it opens nothing else', async () => {
  const local = await app({ selfHost: false });
  expect((await post(local, 'tools/list', {}, { host: '127.0.0.1' })).statusCode).toBe(404);

  const target = await app({ mcpToken });
  expect(() => checkedMcpToken('가'.repeat(32))).toThrow();
  expect((await post(target, 'tools/list', {}, { host })).statusCode).toBe(401);
  const login = await target.inject({
    method: 'POST',
    url: '/api/session',
    headers: { host, origin },
    payload: { token: accessToken },
  });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  expect((await post(target, 'tools/list', {}, { host, origin, cookie })).statusCode).toBe(401);
  expect((await post(target, 'tools/list', {}, { host, cookie })).statusCode).toBe(403);
  expect(
    (await post(target, 'tools/list', {}, { ...bearer, origin: 'https://elsewhere.example' }))
      .statusCode
  ).toBe(403);
  const listed = await post(target, 'tools/list');
  expect(listed.statusCode).toBe(200);
  expect(listed.headers['cache-control']).toBe('no-store');
  expect((await post(target, 'tools/list', {}, { ...bearer, origin })).statusCode).toBe(200);
  expect(
    (await target.inject({ method: 'GET', url: '/api/library', headers: bearer })).statusCode
  ).toBe(401);
  expect(
    (await target.inject({ method: 'GET', url: '/api/mcp', headers: bearer })).statusCode
  ).toBe(405);

  for (let attempt = 0; attempt < 10; attempt++)
    expect(
      (await post(target, 'tools/list', {}, { host, authorization: 'Bearer wrong-token' }))
        .statusCode
    ).toBe(401);
  expect((await post(target, 'tools/list')).statusCode).toBe(429);
  expect(
    (
      await target.inject({
        method: 'POST',
        url: '/api/session',
        headers: { host, origin },
        payload: { token: accessToken },
      })
    ).statusCode
  ).toBe(429);
});

test('a successful MCP call does not reset the browser login failure count', async () => {
  const target = await app({ mcpToken });
  const login = (token: string) =>
    target.inject({
      method: 'POST',
      url: '/api/session',
      headers: { host, origin },
      payload: { token },
    });
  for (let attempt = 0; attempt < 9; attempt++)
    expect((await login('wrong-access-token')).statusCode).toBe(401);
  expect((await post(target, 'tools/list')).statusCode).toBe(200);
  expect((await login('wrong-access-token')).statusCode).toBe(401);
  expect((await login(accessToken)).statusCode).toBe(429);
});

test('a client edits a saved card through MCP without creating helper tasks', async () => {
  const target = await app({ mcpToken });
  const bot = target.store.product.content(
    fixtureBotInput('Harbor keeper', 'The keeper says {{getvar::mood}} at the lighthouse.')
  ) as Content;

  const legacy = await post(target, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  expect(legacy.json().result).toMatchObject({
    protocolVersion: '2025-06-18',
    serverInfo: { name: 'uimori' },
  });
  expect(
    (
      await target.inject({
        method: 'POST',
        url: '/api/mcp',
        headers: bearer,
        payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
      })
    ).statusCode
  ).toBe(202);

  const tools = (await post(target, 'tools/list')).json().result.tools;
  expect(JSON.stringify(tools)).not.toMatch(/captured editor|helper screen|current scope/u);
  expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
    'db_query',
    'data_search',
    'data_read',
    'guide_read',
    'resource_read',
    'resource_readMany',
    'resource_patch',
    'resource_patchMany',
    'resource_clone',
    'resource_undo',
    'preset_validate',
    'code_cbs',
    'code_references',
    'code_diagnose',
    'code_regex',
    'code_preview',
    'chat_preview',
    'chat_variables_read',
    'scene_lore',
    'image_list',
    'task_list',
    'task_inspect',
    'app_tools',
    'app_call',
  ]);

  const read = await call(target, 'resource_read', {
    kind: 'content',
    id: bot.id,
    path: '/package/nativeRisu/card/description',
  });
  expect(read.isError).toBe(false);
  expect(JSON.stringify(read.value)).toContain('at the lighthouse');
  const revision = read.value.revision as number;

  const diagnosed = await call(target, 'code_diagnose', { kind: 'content', id: bot.id });
  expect(diagnosed.isError).toBe(false);

  const changes = [
    {
      op: 'replaceText',
      path: '/package/nativeRisu/card/description',
      oldText: 'at the lighthouse',
      newText: 'at the harbor light',
    },
  ];
  const changed = vi.spyOn(target.store, 'changed');
  const patched = await call(target, 'resource_patch', {
    kind: 'content',
    id: bot.id,
    expectedRevision: revision,
    changes,
  });
  expect(patched.isError, JSON.stringify(patched.value)).toBe(false);
  expect(changed).toHaveBeenCalledWith(null);
  expect(
    (target.store.product.available('content', bot.id) as Content).package.nativeRisu
  ).toMatchObject({
    card: { description: 'The keeper says {{getvar::mood}} at the harbor light.' },
  });

  const stale = await call(target, 'resource_patch', {
    kind: 'content',
    id: bot.id,
    expectedRevision: revision,
    changes,
  });
  expect(stale).toMatchObject({ isError: true, value: { code: 'REVISION_CONFLICT' } });

  const unsupported = await post(
    target,
    'tools/call',
    {
      name: 'resource_patch',
      arguments: { kind: 'content', id: bot.id, expectedRevision: revision + 1, changes },
    },
    { ...bearer, 'mcp-protocol-version': '2099-01-01' }
  );
  expect(unsupported.statusCode).toBe(400);
  expect((target.store.product.available('content', bot.id) as Content).revision).toBe(
    revision + 1
  );

  const unknown = await call(target, 'resource_read', { kind: 'content', id: bot.id, extra: 1 });
  expect(unknown).toMatchObject({ isError: true, value: { code: 'INVALID_ARGUMENTS' } });

  const undone = await call(target, 'resource_undo', {
    kind: 'content',
    id: bot.id,
    expectedRevision: revision + 1,
  });
  expect(undone.isError, JSON.stringify(undone.value)).toBe(false);
  expect(
    (target.store.product.available('content', bot.id) as Content).package.nativeRisu
  ).toMatchObject({ card: { description: 'The keeper says {{getvar::mood}} at the lighthouse.' } });

  const searched = await call(target, 'data_search', { patterns: ['lighthouse'] });
  expect(searched.isError, JSON.stringify(searched.value)).toBe(false);
  expect(JSON.stringify(searched.value)).toContain(bot.id);
  const helperScope = await call(target, 'data_search', { scope: 'editor', patterns: ['x'] });
  expect(helperScope).toMatchObject({
    isError: true,
    value: { code: 'DATA_SCOPE_INVALID', retryMode: 'correct_arguments' },
  });

  const queried = await call(target, 'db_query', {
    sql: 'SELECT id, title FROM agent_resources WHERE id=?',
    params: [bot.id],
  });
  expect(queried.isError, JSON.stringify(queried.value)).toBe(false);
  expect(JSON.stringify(queried.value)).toContain('Harbor keeper');

  for (const table of ['helper_tasks', 'helper_events', 'helper_operations'])
    expect(target.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(0);
});

test('MCP explains a failed run and reaches app operations, but never starts paid generation', async () => {
  const target = await app({ mcpToken });
  const store = target.store;
  const connection = store.product.connection({
    title: 'Direct provider',
    protocol: 'openai-chat-v1',
    endpoint: 'https://private-endpoint.example/v1',
    credentialRef: 'PRIVATE_KEY_REF',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Storm writer',
    connectionId: connection.id,
    modelId: 'storm-writer-1',
    maxOutputTokens: 1024,
    temperature: null,
  }) as ModelPreset;
  const chat = createFixtureChat(store, 'Harbor night');
  const profile = {
    ...store.product.snapshot(chat.id),
    models: { main: store.product.modelSnapshot(model.id) },
  };
  const request = 'Write the storm over the harbor.';
  const { run } = store.createRun(
    chat.id,
    {
      request,
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: 'mcp-failed-run',
    },
    (current) => ({
      chatId: chat.id,
      parentRevision: current.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request,
      history: store.history(current.headRevision),
      resources: store.product.resources(chat.id, profile),
      profile,
    })
  );
  store.startRun(run.id);
  const wire = {
    connectionId: connection.id,
    role: 'main' as const,
    protocol: 'openai-chat-v1' as const,
    method: 'POST' as const,
    url: 'https://provider.invalid',
    headers: {},
    body: {},
    bodySha256: 'synthetic',
    stablePrefixSha256: 'synthetic',
  };
  store.product.startAttempt(
    chat.id,
    run.id,
    null,
    { ...wire, modelId: model.modelId },
    {
      kind: 'writing',
    }
  );
  store.product.startAttempt(
    chat.id,
    run.id,
    null,
    { ...wire, modelId: 'refusal-judge-1' },
    {
      kind: 'judgment',
    }
  );
  store.finishRun(run.id, 'failed', 'PROVIDER_FAILED');
  const laterRun = (key: string, extra: Record<string, unknown> = {}) => {
    const created = store.createRun(
      chat.id,
      {
        request,
        expectedRevision: chat.headRevision,
        expectedSettingsRevision: chat.settingsRevision,
        idempotencyKey: key,
      },
      (current) => ({
        chatId: chat.id,
        parentRevision: current.headRevision,
        settingsRevision: current.settingsRevision,
        settings: current.settings,
        request,
        history: store.history(current.headRevision),
        resources: store.product.resources(chat.id, profile),
        profile,
        ...extra,
      })
    ).run;
    store.startRun(created.id);
    store.finishRun(created.id, 'failed', 'CONTEXT_TOO_LARGE');
    return created;
  };
  const unsent = laterRun('mcp-unsent-run');
  const imported = laterRun('mcp-imported-run', { transcriptImport: { index: 0 } });

  const listed = await call(target, 'task_list', { status: 'failed' });
  expect(listed.value.tasks).toContainEqual(expect.objectContaining({ kind: 'run', id: run.id }));
  const inspected = await call(target, 'task_inspect', { kind: 'run', id: run.id });
  expect(inspected).toMatchObject({
    isError: false,
    value: {
      status: 'failed',
      error: 'PROVIDER_FAILED',
      request: { text: request, totalChars: request.length, truncated: false },
      model: {
        title: 'Storm writer',
        providerModelId: 'storm-writer-1',
        protocol: 'openai-chat-v1',
        executionMode: 'realtime',
      },
    },
  });
  expect((await call(target, 'task_inspect', { kind: 'run', id: unsent.id })).value.model).toEqual({
    title: 'Storm writer',
    providerModelId: null,
    protocol: null,
    executionMode: null,
  });
  expect(
    (await call(target, 'task_inspect', { kind: 'run', id: imported.id })).value.model
  ).toBeNull();
  expect(JSON.stringify(inspected.value)).not.toMatch(/PRIVATE_KEY_REF|private-endpoint/u);

  const botId = chat.botId;
  const folders = await call(target, 'app_call', {
    name: 'library.organize',
    arguments: { action: 'read' },
  });
  const invalidated = vi.spyOn(store, 'invalidated');
  const folder = await call(target, 'app_call', {
    name: 'library.organize',
    arguments: {
      action: 'create-folder',
      body: { expectedRevision: folders.value.revision, category: 'bot', title: 'Kept' },
    },
  });
  expect(folder.isError, JSON.stringify(folder.value)).toBe(false);
  expect(invalidated).toHaveBeenCalledWith('resources');
  const runsBefore = store.db.prepare('SELECT count(*) AS n FROM runs').get()!.n;
  const refused: [string, Record<string, unknown>][] = [
    ['scene.request', { chatId: chat.id, request: 'Again.' }],
    ['scene.translate', { chatId: chat.id, sourceId: 'any' }],
    ['task.retry', { kind: 'run', id: run.id }],
    ['task.cancel', { kind: 'run', id: run.id }],
    ['chat.lore', { chatId: chat.id, action: 'remove', body: {} }],
  ];
  for (const [name, args] of refused) {
    const result = await call(target, 'app_call', { name, arguments: args });
    expect(result, name).toMatchObject({
      isError: true,
      value: { code: 'MCP_OPERATION_UNAVAILABLE', retryMode: 'never' },
    });
  }
  const malformed: [Record<string, unknown>, string][] = [
    [{ name: 'chat.list' }, 'INVALID_ARGUMENTS'],
    [{ name: 'library.organize', arguments: null }, 'INVALID_ARGUMENTS'],
    [{ name: 'library.organize', arguments: {} }, 'INVALID_ARGUMENTS'],
    [{ name: 'chat.list', arguments: {}, extra: 1 }, 'INVALID_ARGUMENTS'],
    [
      { name: 'chat.lore', arguments: { chatId: chat.id, action: ['read'] } },
      'MCP_OPERATION_UNAVAILABLE',
    ],
    [
      { name: 'chat.lore', arguments: { chatId: chat.id, action: 'read', body: {} } },
      'INVALID_ARGUMENTS',
    ],
    [
      { name: 'chat.organize', arguments: { action: 'read', botId, chatId: chat.id } },
      'INVALID_ARGUMENTS',
    ],
  ];
  for (const [args, code] of malformed)
    expect(await call(target, 'app_call', args), JSON.stringify(args)).toMatchObject({
      isError: true,
      value: { code },
    });
  const described = await call(target, 'app_tools', { names: ['scene.request'] });
  expect(described.value.code).toBe('MCP_OPERATION_UNAVAILABLE');
  const catalog = await call(target, 'app_tools', { limit: 200 });
  for (const tool of catalog.value.tools as { name: string }[])
    expect(['scene.request', 'scene.translate', 'task.retry']).not.toContain(tool.name);
  const effects = Object.fromEntries(
    (catalog.value.tools as { name: string; effect: string }[]).map((tool) => [
      tool.name,
      tool.effect,
    ])
  );
  expect(effects).toMatchObject({ 'chat.lore': 'read', 'library.organize': 'mixed' });

  expect(store.db.prepare('SELECT count(*) AS n FROM runs').get()!.n).toBe(runsBefore);

  const index = await call(target, 'app_call', {
    name: 'chat.read',
    arguments: { chatId: chat.id },
  });
  expect(index).toMatchObject({ isError: false, value: { chat: { id: chat.id } } });
  const titleRevision = store.chat(chat.id).titleRevision ?? 0;
  const stale = await call(target, 'app_call', {
    name: 'chat.rename',
    arguments: { chatId: chat.id, title: 'Harbor dawn', expectedRevision: titleRevision + 1 },
  });
  expect(stale).toMatchObject({ isError: true, value: { code: 'REVISION_CONFLICT' } });
  const renamed = await call(target, 'app_call', {
    name: 'chat.rename',
    arguments: { chatId: chat.id, title: 'Harbor dawn', expectedRevision: titleRevision },
  });
  expect(renamed.isError, JSON.stringify(renamed.value)).toBe(false);
  expect(store.chat(chat.id).title).toBe('Harbor dawn');

  for (const table of ['helper_tasks', 'helper_events'])
    expect(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(0);
});

test('MCP deletes only while the owner allows it in the settings, and cannot allow it itself', async () => {
  const target = await app({ mcpToken });
  const store = target.store;
  const allow = (mcpAllowDelete?: boolean) => {
    const current = modelWorkspace(store);
    return updateModelWorkspace(store, {
      expectedRevision: current.revision,
      routes: current.routes,
      translationPolicy: current.translationPolicy,
      ...(mcpAllowDelete === undefined ? {} : { mcpAllowDelete }),
    }).mcpAllowDelete;
  };
  const gateway = (name: string, args: Record<string, unknown>) =>
    call(target, 'app_call', { name, arguments: args });

  const bot = store.product.content(fixtureBotInput('Doomed card')) as Content;
  const doomed = createFixtureChat(store, 'Doomed chat');
  const { chat, source } = chatWithSource(store);
  const { revision: illustrationRevision, ...illustration } = fixtureSettings({ maxPerSource: 3 });
  updateIllustrationSettings(
    store,
    { expectedRevision: illustrationRevision, ...illustration },
    true
  );
  const anchor = splitSource(source)[0]!.anchor;
  const jobId = generateHelperIllustrations(
    store,
    chat.id,
    {
      moments: [
        {
          sourceId: source.id,
          expectedSourceHash: source.hash,
          startAnchor: anchor,
          endAnchor: anchor,
          focus: 'The lantern',
        },
      ],
    },
    { testMode: true }
  ).plans[0]!.jobId;
  cancelIllustration(store, jobId);
  const cut = listIllustrationCuts(store, chat.id, { sourceId: source.id }).cuts[0]!;
  const connection = store.product.connection({
    title: 'Unused provider',
    protocol: 'openai-chat-v1',
    endpoint: 'http://127.0.0.1:44997/v1',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Doomed model',
    connectionId: connection.id,
    modelId: 'doomed-1',
    maxOutputTokens: 512,
    temperature: null,
  }) as ModelPreset;
  const combination = store.product.promptCombination({
    workspaceRevision: promptWorkspace(store).revision,
    title: 'Doomed options',
    role: 'main',
    values: {},
  }) as { id: string; revision: number };
  const palette = savePalette(store, {
    title: 'Doomed palette',
    description: '',
    colors: { light: {}, dark: {} },
  });
  const font = registerFont(store, {
    title: 'Doomed font',
    bytes: readFileSync(join(import.meta.dirname, 'fixtures/appearance-synthetic.ttf')),
  });
  const folder = store.libraryOrganization
    .createFolder({
      expectedRevision: store.libraryOrganization.snapshot().revision,
      category: 'bot',
      title: 'Doomed folder',
    })
    .folders.find((item) => item.title === 'Doomed folder')!;

  const deletions: [string, () => Record<string, unknown>][] = [
    ['resource.delete', () => ({ kind: 'content', id: bot.id, expectedRevision: bot.revision })],
    ['chat.delete', () => ({ chatId: doomed.id })],
    [
      'illustration.cut.delete',
      () => ({
        chatId: chat.id,
        expectedLatestJobId: jobId,
        expectedSourceHash: source.hash,
        expectedPresentationRevision: cut.presentationRevision,
      }),
    ],
    ['model.delete', () => ({ modelId: model.id, expectedRevision: model.revision })],
    [
      'prompt.combination.delete',
      () => ({ id: combination.id, expectedRevision: combination.revision }),
    ],
    ['font.delete', () => ({ id: font.id })],
    ['palette.delete', () => ({ id: palette.id, expectedRevision: palette.revision })],
    [
      'library.organize',
      () => ({
        action: 'delete-folder',
        body: {
          expectedRevision: store.libraryOrganization.snapshot().revision,
          category: 'bot',
          folderId: folder.id,
        },
      }),
    ],
  ];

  expect(modelWorkspace(store).mcpAllowDelete).toBe(false);
  for (const [name, args] of deletions) {
    const refused = await gateway(name, args());
    expect(refused, name).toMatchObject({
      isError: true,
      value: { code: 'MCP_DELETE_DISABLED', retryMode: 'never', outcome: 'unchanged' },
    });
    expect(refused.value.error, name).toContain(MCP_DELETE_SETTING);
  }

  const editable = editableResource('prompt-workspace', promptWorkspace(store));
  const saved = await gateway('resource.save', {
    kind: 'prompt-workspace',
    expectedRevision: promptWorkspace(store).revision,
    model: editable,
  });
  expect(saved.isError, JSON.stringify(saved.value)).toBe(false);
  expect(
    await gateway('resource.save', {
      kind: 'prompt-workspace',
      expectedRevision: promptWorkspace(store).revision,
      model: { ...editable, mcpAllowDelete: true },
    })
  ).toMatchObject({ isError: true, value: { code: 'INVALID_REQUEST' } });
  const patched = await call(target, 'resource_patch', {
    kind: 'prompt-workspace',
    id: 'current',
    expectedRevision: promptWorkspace(store).revision,
    changes: [{ op: 'set', path: '/mcpAllowDelete', value: true }],
  });
  expect(patched).toMatchObject({ isError: true, value: { code: 'INVALID_ARGUMENTS' } });
  expect(patched.value.error).toContain('kind must be content, prompt-preset or theme');
  expect(modelWorkspace(store).mcpAllowDelete).toBe(false);
  expect(await gateway('chat.delete', { chatId: doomed.id })).toMatchObject({
    isError: true,
    value: { code: 'MCP_DELETE_DISABLED' },
  });

  expect(allow(true)).toBe(true);
  expect(allow()).toBe(true);
  const stale = await gateway('resource.delete', {
    kind: 'content',
    id: bot.id,
    expectedRevision: bot.revision + 1,
  });
  expect(stale).toMatchObject({ isError: true, value: { code: 'REVISION_CONFLICT' } });
  const invalidated = vi.spyOn(store, 'invalidated');
  const signalled: Record<string, string[]> = {};
  for (const [name, args] of deletions) {
    invalidated.mockClear();
    const deleted = await gateway(name, args());
    expect(deleted.isError, `${name} ${JSON.stringify(deleted.value)}`).toBe(false);
    signalled[name] = invalidated.mock.calls.map(([change]) => change);
  }
  for (const name of ['resource.delete', 'model.delete', 'prompt.combination.delete'])
    expect(signalled[name], name).toContain('resources');
  expect(signalled['chat.delete']).toContain('chats');
  expect(await gateway('chat.delete', { chatId: doomed.id })).toMatchObject({
    isError: true,
    value: { code: 'REVISION_CONFLICT' },
  });
  expect(() => store.chat(doomed.id)).toThrow();
  expect(() => store.product.available('content', bot.id)).toThrow();
  expect(() => store.product.available('model', model.id)).toThrow();
  expect(() => store.product.available('prompt-combination', combination.id)).toThrow();
  expect(listIllustrationCuts(store, chat.id, { sourceId: source.id }).cuts).toEqual([]);
  expect(JSON.stringify(fontCatalog(store))).not.toContain(font.id);
  expect(JSON.stringify(paletteCatalog(store))).not.toContain(palette.id);
  expect(JSON.stringify(store.libraryOrganization.snapshot())).not.toContain(folder.id);

  expect(await gateway('scene.request', { chatId: chat.id, request: 'Again.' })).toMatchObject({
    isError: true,
    value: { code: 'MCP_OPERATION_UNAVAILABLE' },
  });
  expect(allow(false)).toBe(false);
  expect(await gateway('chat.delete', { chatId: chat.id })).toMatchObject({
    isError: true,
    value: { code: 'MCP_DELETE_DISABLED' },
  });
  expect(store.chat(chat.id).id).toBe(chat.id);
  for (const table of ['helper_tasks', 'helper_events'])
    expect(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(0);
});

test('a delete operation added to the MCP gateway without its marker stops the module from loading', async () => {
  vi.resetModules();
  vi.doMock('../server/helper-confirmation-traits.js', () => ({
    helperConfirmationTrait: (name: string) => (name === 'chat.rename' ? 'delete' : undefined),
  }));
  try {
    await expect(import('../server/mcp-tools.js')).rejects.toThrow(
      'MCP delete operation must be listed under deletes: chat.rename'
    );
  } finally {
    vi.doUnmock('../server/helper-confirmation-traits.js');
    vi.resetModules();
  }
});

test('a mixed operation opened on MCP with every action stops the module from loading while one of them deletes', async () => {
  const operations = '../server/mcp-app-operations.js';
  vi.resetModules();
  vi.doMock(operations, async () => {
    const actual =
      await vi.importActual<typeof import('../server/mcp-app-operations.js')>(operations);
    const {
      actions: _actions,
      fields: _fields,
      ...bookmark
    } = actual.MCP_APP_OPERATIONS['chat.bookmark']!;
    return {
      ...actual,
      MCP_APP_OPERATIONS: {
        ...actual.MCP_APP_OPERATIONS,
        'chat.bookmark': { ...bookmark, readOnly: false },
      },
    };
  });
  try {
    await expect(import('../server/mcp-tools.js')).rejects.toThrow(
      /MCP delete action must be listed under deletes: chat\.bookmark .*delete/u
    );
  } finally {
    vi.doUnmock(operations);
    vi.resetModules();
  }
});

test('the refusal names the delete setting as the settings screen labels it', () => {
  expect(MCP_DELETE_SETTING).toBe(settingsMessages['settings.mcpAllowDelete'].en);
});

test('MCP saves answer a stale or deleted target with REVISION_CONFLICT before other checks', async () => {
  const target = await app({ mcpToken });
  const store = target.store;
  const bot = store.product.content(fixtureBotInput('Lantern card')) as Content;
  const stale = await call(target, 'app_call', {
    name: 'image.update-metadata',
    arguments: {
      contentId: bot.id,
      imageId: 'no-such-image',
      expectedRevision: bot.revision + 1,
      title: 'Lantern',
      description: '',
    },
  });
  expect(stale).toMatchObject({ isError: true, value: { code: 'REVISION_CONFLICT' } });
  deleteLibraryItem(store, 'content', bot.id, { expectedRevision: bot.revision });
  const removed = await call(target, 'app_call', {
    name: 'image.update-metadata',
    arguments: {
      contentId: bot.id,
      imageId: 'no-such-image',
      expectedRevision: bot.revision,
      title: 'Lantern',
      description: '',
    },
  });
  expect(removed).toMatchObject({ isError: true, value: { code: 'REVISION_CONFLICT' } });

  const chat = createFixtureChat(store, 'Gone soon');
  deleteChat(store, chat.id);
  const renamed = await call(target, 'app_call', {
    name: 'chat.rename',
    arguments: { chatId: chat.id, title: 'Back', expectedRevision: chat.titleRevision ?? 0 },
  });
  expect(renamed).toMatchObject({ isError: true, value: { code: 'REVISION_CONFLICT' } });
});

test('MCP gateway saves refuse a body field the published schema does not list', async () => {
  const target = await app({ mcpToken });
  const store = target.store;
  const organization = store.libraryOrganization.snapshot();
  const created = await call(target, 'app_call', {
    name: 'library.organize',
    arguments: {
      action: 'create-folder',
      body: { expectedRevision: organization.revision, category: 'bot', title: 'Covered' },
    },
  });
  const folder = (created.value.folders as { id: string; title: string }[]).find(
    (item) => item.title === 'Covered'
  )!;
  const cleared = await call(target, 'app_call', {
    name: 'library.organize',
    arguments: {
      action: 'update-folder',
      body: {
        expectedRevision: created.value.revision,
        category: 'bot',
        folderId: folder.id,
        coverImageHash: null,
      },
    },
  });
  expect(cleared).toMatchObject({ isError: true, value: { code: 'INVALID_ARGUMENTS' } });
  expect(store.libraryOrganization.snapshot().revision).toBe(created.value.revision);
});

test('a failed run inspected over MCP shows no provider key or MCP token', async () => {
  const target = await app({ mcpToken, selfHost: false });
  const store = target.store;
  const credential = 'SYNTHETIC_MCP_LEAK_TEST_CREDENTIAL';
  const secret = 'synthetic-provider-key-that-must-never-leak-0000';
  store.credentials.set(credential, secret);
  const sent: string[] = [];
  const fetched = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    const authorization = new Headers(options?.headers).get('authorization') ?? '';
    sent.push(authorization);
    return new Response(
      JSON.stringify({
        error: { message: `invalid key ${authorization} ${secret} ${mcpToken}` },
      }),
      { status: 401, headers: { 'content-type': 'application/json' } }
    );
  });
  const connection = store.product.connection({
    title: 'Leaky provider',
    protocol: 'openai-chat-v1',
    endpoint: 'http://127.0.0.1:44998/v1',
    credentialRef: credential,
    enabled: true,
  });
  const model = store.product.model({
    title: 'Leak check model',
    connectionId: connection.id,
    modelId: 'leak-check-1',
    maxOutputTokens: 512,
    temperature: null,
  }) as ModelPreset;
  const chat = createFixtureChat(store, 'Leak check');
  const profile = store.product.profile(chat.id);
  updateTestProfile(store.product, chat.id, {
    expectedRevision: profile.revision,
    routes: { main: { id: model.id }, translation: null },
    image: profile.image,
  });
  const current = store.chat(chat.id);
  const started = await injectWithFixtureBot(target, {
    method: 'POST',
    url: `/api/chats/${chat.id}/runs`,
    headers: { host: '127.0.0.1' },
    payload: {
      request: 'Continue the harbor scene.',
      expectedRevision: current.headRevision,
      expectedSettingsRevision: current.settingsRevision,
      idempotencyKey: 'mcp-leak-run',
    },
  });
  expect(started.statusCode, started.body).toBe(200);
  const runId = started.json().id as string;
  await vi.waitFor(() => expect(['queued', 'running']).not.toContain(store.run(runId).status), {
    timeout: 10_000,
    interval: 20,
  });
  expect(fetched).toHaveBeenCalled();
  expect(sent.join(' ')).toContain(secret);
  expect(store.run(runId).status).toBe('failed');

  const listed = await call(
    target,
    'task_list',
    { status: 'failed', chatId: chat.id },
    '127.0.0.1'
  );
  const inspected = await call(
    target,
    'task_inspect',
    { kind: 'run', id: runId, includeDiagnostics: true },
    '127.0.0.1'
  );
  expect(inspected.isError, JSON.stringify(inspected.value)).toBe(false);
  for (const output of [listed.value, inspected.value]) {
    const text = JSON.stringify(output);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(mcpToken);
  }
});

test('the 2026-07-28 revision is discovered, checks its headers and serves skills with digests', async () => {
  const target = await app({ mcpToken });
  const discovered = (await modern(target, 'server/discover')).json().result;
  expect(discovered).toMatchObject({
    resultType: 'complete',
    supportedVersions: expect.arrayContaining([MODERN, '2025-06-18']),
    capabilities: {
      tools: {},
      resources: {},
      extensions: { 'io.modelcontextprotocol/skills': {} },
    },
    cacheScope: 'private',
  });

  const mismatch = await post(
    target,
    'tools/list',
    { _meta: meta },
    { ...bearer, 'mcp-protocol-version': '2025-11-25', 'mcp-method': 'tools/list' }
  );
  expect(mismatch.statusCode).toBe(400);
  expect(mismatch.json().error.code).toBe(-32020);
  const unsupported = await post(
    target,
    'tools/list',
    { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } },
    { ...bearer, 'mcp-protocol-version': '2099-01-01', 'mcp-method': 'tools/list' }
  );
  expect(unsupported.json().error).toMatchObject({
    code: -32022,
    data: { supported: expect.arrayContaining([MODERN]) },
  });

  type Manifest = { uri: string; size: number; digest: string };
  type Listed = { uri: string; frontmatter: { name: string }; resources: Manifest[] };
  const skills: Listed[] = (await modern(target, 'skills/list')).json().result.skills;
  expect(skills.length).toBeGreaterThanOrEqual(3);
  for (const listed of skills)
    expect(listed.uri).toBe(`skill://${listed.frontmatter.name}/SKILL.md`);
  const lore = skills.find((skill) => skill.frontmatter.name === 'uimori-lorebooks')!;
  const got: Listed = (await modern(target, 'skills/get', { uri: lore.uri })).json().result.skill;
  expect(got).toEqual(lore);
  const served = async (file: Manifest) => {
    const text: string = (await modern(target, 'resources/read', { uri: file.uri })).json().result
      .contents[0].text;
    const bytes = Buffer.from(text, 'utf8');
    expect(bytes.length).toBe(file.size);
    expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(file.digest);
    return text;
  };
  await served(got.resources.find((file) => file.uri.endsWith('LORE-CONTEXT.md'))!);
  const skill = await served(got.resources.find((file) => file.uri === lore.uri)!);
  expect(skill).toContain('](guides/LORE-CONTEXT.md)');

  setMaintenance(target.store, { closed: true });
  expect((await modern(target, 'tools/list')).statusCode).toBe(503);
});

test('MCP read tools advertise and enforce the dedicated MCP page token budget', async () => {
  const target = await app({ mcpToken });
  const tools = (await post(target, 'tools/list')).json().result.tools as {
    name: string;
    description: string;
  }[];
  for (const name of [
    'resource_read',
    'resource_readMany',
    'preset_validate',
    'code_cbs',
    'code_references',
    'code_diagnose',
    'code_regex',
    'chat_preview',
    'chat_variables_read',
    'scene_lore',
  ]) {
    const tool = tools.find((item) => item.name === name);
    expect(tool?.description, name).toContain(String(MCP_READ_TOKEN_BUDGET));
  }
  const dense = '\u0001'.repeat(5_000);
  const input = fixtureBotInput('Dense card', dense);
  input.package.nativeRisu.card.character_book = {
    entries: [
      { comment: 'A', keys: ['a'], content: dense, enabled: true },
      { comment: 'B', keys: ['b'], content: dense, enabled: true },
      { comment: 'C', keys: ['c'], content: dense, enabled: true },
    ],
  };
  const bot = target.store.product.content(input) as Content;
  const single = await call(target, 'resource_read', {
    kind: 'content',
    id: bot.id,
    path: '/package/nativeRisu/card/character_book/entries/0/content',
    textLimit: 10_000,
  });
  expect(single.isError).toBe(false);
  expect(countTextTokens(JSON.stringify(single.value))).toBeGreaterThan(12_000);
  expect(single.value).toMatchObject({ text: dense, nextOffset: null });

  const many = await call(target, 'resource_readMany', {
    items: [0, 1, 2].map((index) => ({
      kind: 'content',
      id: bot.id,
      path: `/package/nativeRisu/card/character_book/entries/${index}/content`,
      textLimit: 10_000,
    })),
  });
  expect(many.isError).toBe(false);
  expect(countTextTokens(JSON.stringify(many.value))).toBeLessThanOrEqual(MCP_READ_TOKEN_BUDGET);
  expect(many.value.nextIndex).not.toBeNull();
});
