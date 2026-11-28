import { afterEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../server/app.js';
import { setMaintenance } from '../server/maintenance.js';
import { MCP_READ_TOKEN_BUDGET } from '../server/mcp-tools.js';
import { mcpToken as checkedMcpToken } from '../server/network-policy.js';
import type { Content } from '../core/product.js';
import { countTextTokens } from '../core/text-tokens.js';
import { fixtureBotInput } from './fixtures/chat.js';

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
function modern(target: App, method: string, params: Record<string, unknown> = {}) {
  const name = params.name ?? params.uri;
  return post(
    target,
    method,
    { ...params, _meta: meta },
    {
      ...bearer,
      'mcp-protocol-version': MODERN,
      'mcp-method': method,
      ...(typeof name === 'string' ? { 'mcp-name': name } : {}),
    }
  );
}
async function call(target: App, name: string, args: Record<string, unknown>) {
  const response = await modern(target, 'tools/call', { name, arguments: args });
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

  for (const table of ['helper_tasks', 'helper_events', 'helper_changes'])
    expect(target.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(0);
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
