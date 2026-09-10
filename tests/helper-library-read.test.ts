import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { Content, PromptPreset } from '../core/product.js';
import type { ToolEvent } from '../core/types.js';
import * as transport from '../core/transport.js';
import { HelperRuntime } from '../server/helper-runtime.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { ResponseStreamStore } from '../server/response-stream.js';
import { HttpError } from '../server/request-validation.js';
import { Store } from '../server/store.js';
import { fixtureBotInput } from './fixtures/chat.js';

const owned: { store: Store; path: string }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, path } of owned.splice(0)) {
    store.close();
    const inside = relative(tmpdir(), path);
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-library-read-'))
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});

function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-library-read-')),
    store = new Store(join(path, 'synthetic.sqlite'));
  owned.push({ store, path });
  const contents = ['bot', 'persona', 'module'].map(
    (kind, index) =>
      store.product.content({
        ...fixtureBotInput(`자료 ${index} "quoted" 🌱`, `Body ${index}. `.padEnd(32768, 'x')),
        kind,
      }) as Content
  );
  const prompts = ['main', 'translation'].map(
    (role) =>
      store.product.promptPreset({
        title: `${role} "프롬프트" 🌱`,
        role,
        text: `Prompt ${role}. `.padEnd(32768, 'p'),
      }) as PromptPreset
  );
  return { store, contents, prompts };
}

function legacyMetadata(store: Store) {
  return {
    contents: store.product
      .all('content')
      .map(({ id, revision, title, kind }) => ({ id, revision, title, kind })),
    prompts: store.product
      .all('prompt-preset')
      .map(({ id, revision, title, role }) => ({ id, revision, title, role })),
  };
}

test('library metadata keeps the exact latest visible response and never transfers full bodies into JS', () => {
  const f = fixture(),
    content = f.contents[0]!,
    prompt = f.prompts[0]!;
  f.store.product.content(
    { ...fixtureBotInput('개정한 자료 🌱', content.text), expectedRevision: content.revision },
    content.id
  );
  f.store.product.promptPreset(
    {
      title: '개정한 프롬프트 🌱',
      role: prompt.role,
      program: prompt.program,
      expectedRevision: prompt.revision,
    },
    prompt.id
  );
  const assertSame = () => {
    const expected = legacyMetadata(f.store),
      actual = f.store.product.libraryMetadata();
    expect(actual).toEqual(expected);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    expect(actual.contents.map((item) => item.id)).toEqual(
      actual.contents.map((item) => item.id).sort()
    );
    return actual;
  };
  const current = assertSame();
  expect(current.contents.find((item) => item.id === content.id)).toMatchObject({ revision: 2 });
  expect(current.prompts.find((item) => item.id === prompt.id)).toMatchObject({ revision: 2 });
  for (const [kind, id] of [
    ['content', content.id],
    ['prompt-preset', prompt.id],
  ]) {
    f.store.db.prepare('INSERT INTO library_hidden VALUES(?,?)').run(kind!, id!);
    const hidden = assertSame();
    expect([...hidden.contents, ...hidden.prompts].some((item) => item.id === id)).toBe(false);
    f.store.db.prepare('DELETE FROM library_hidden WHERE kind=? AND id=?').run(kind!, id!);
    expect(assertSame()).toEqual(current);
  }
  const prepare = f.store.db.prepare.bind(f.store.db),
    returnedRows: Record<string, unknown>[] = [];
  vi.spyOn(f.store.db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql),
      all = statement.all.bind(statement);
    vi.spyOn(statement, 'all').mockImplementation((...args) => {
      const rows = all(...args);
      returnedRows.push(...rows);
      return rows;
    });
    return statement;
  });
  expect(f.store.product.libraryMetadata()).toEqual(current);
  expect(returnedRows).toHaveLength(5);
  expect(Buffer.byteLength(JSON.stringify(returnedRows))).toBeLessThan(2000);
  for (const row of returnedRows) {
    expect(row).not.toHaveProperty('body');
    expect(row).not.toHaveProperty('text');
    expect(row).not.toHaveProperty('program');
    expect(row).not.toHaveProperty('package');
  }
});

test('library search returns bounded metadata pages with normalized title, ID and category matches only', () => {
  const f = fixture();
  for (let index = 0; index < 105; index++)
    f.store.product.content(
      fixtureBotInput(`Alpha ${index} 자료`, `BodyOnlySearchToken ${index}. `.padEnd(2048, 'x'))
    );
  const first = f.store.product.searchLibrary({ query: '' }),
    all = f.store.product.libraryMetadata();
  expect(first).toMatchObject({ total: 110, offset: 0, nextOffset: 20 });
  expect(first.items).toHaveLength(20);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(
    Buffer.byteLength(JSON.stringify(all)) / 4
  );
  const found: typeof first.items = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = f.store.product.searchLibrary({ query: '  ', offset });
    expect(page.items.length).toBeLessThanOrEqual(20);
    found.push(...page.items);
    offset = page.nextOffset;
  }
  expect(found).toHaveLength(first.total);
  expect(new Set(found.map((item) => `${item.kind}:${item.id}`)).size).toBe(first.total);
  expect(f.store.product.searchLibrary({ query: '', offset: 1000 })).toEqual({
    items: [],
    total: first.total,
    offset: 1000,
    nextOffset: null,
  });
  const normalized = f.store.product.searchLibrary({ query: '  ＡＬｐｈａ\tＢＯＴ ', limit: 50 });
  expect(normalized).toMatchObject({ total: 105, nextOffset: 50 });
  expect(normalized.items).toHaveLength(50);
  expect(normalized.items.every((item) => item.kind === 'content' && item.category === 'bot')).toBe(
    true
  );
  const selected = normalized.items[0]!;
  expect(f.store.product.searchLibrary({ query: `${selected.id} alpha BOT` }).items).toEqual([
    selected,
  ]);
  expect(f.store.product.searchLibrary({ query: 'Alpha translation' }).items).toEqual([]);
  expect(f.store.product.searchLibrary({ query: 'BodyOnlySearchToken' }).total).toBe(0);
  const prompts = f.store.product.searchLibrary({ query: '', kind: 'prompt-preset' });
  expect(prompts.items).toHaveLength(2);
  expect(prompts.items.map((item) => item.category).sort()).toEqual(['main', 'translation']);

  const content = f.store.product.get<Content>('content', selected.id);
  f.store.product.content(
    { ...fixtureBotInput('새 제목 Beacon', content.text), expectedRevision: content.revision },
    content.id
  );
  expect(f.store.product.searchLibrary({ query: `${content.id} alpha` }).total).toBe(0);
  expect(f.store.product.searchLibrary({ query: `${content.id} ＢＥＡＣＯＮ` }).items).toEqual([
    { id: content.id, revision: 2, title: '새 제목 Beacon', kind: 'content', category: 'bot' },
  ]);
  for (const [kind, id] of [
    ['content', content.id],
    ['prompt-preset', f.prompts[0]!.id],
  ]) {
    f.store.db.prepare('INSERT INTO library_hidden VALUES(?,?)').run(kind!, id!);
    expect(f.store.product.searchLibrary({ query: id }).total).toBe(0);
  }
  for (const item of found) {
    expect(Object.keys(item).sort()).toEqual(['category', 'id', 'kind', 'revision', 'title']);
  }
});

test.each([
  {},
  { query: null },
  { query: 1 },
  { query: 'x'.repeat(201) },
  { query: '', unknown: true },
  { query: '', kind: 'bot' },
  { query: '', offset: -1 },
  { query: '', offset: 1.5 },
  { query: '', offset: '0' },
  { query: '', limit: 0 },
  { query: '', limit: 51 },
  { query: '', limit: 1.5 },
])('library search rejects invalid arguments %j', (args) => {
  const f = fixture();
  expect(() => f.store.product.searchLibrary(args)).toThrow(HttpError);
});

test('helper searches metadata then reads the discovered item without changing existing listing or read permissions', async () => {
  const f = fixture(),
    connection = f.store.product.connection({
      title: 'Synthetic helper',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9',
      enabled: true,
    }),
    model = f.store.product.model({
      title: 'Synthetic helper',
      connectionId: connection.id,
      modelId: 'fixture-helper',
      temperature: null,
      maxOutputTokens: 1024,
    }),
    workspace = modelWorkspace(f.store);
  updateModelWorkspace(f.store, {
    expectedRevision: workspace.revision,
    routes: workspace.routes,
    translationPolicy: workspace.translationPolicy,
    helperModel: { id: model.id },
  });
  const work: Promise<void>[] = [],
    runtime = new HelperRuntime(f.store, {
      approvedOrigins: ['http://127.0.0.1:9'],
      owner: 'synthetic-library-read',
      signal: new AbortController().signal,
      track: (pending) => work.push(pending),
      streams: new ResponseStreamStore(f.store),
    }),
    conversation = runtime.workspace.open({ kind: 'library', workId: 'metadata-read' }),
    expected = legacyMetadata(f.store),
    all = f.store.product.all.bind(f.store.product);
  vi.spyOn(f.store.product, 'all').mockImplementation((kind) => {
    if (kind === 'content' || kind === 'prompt-preset')
      throw new Error('Metadata reads must not load full library bodies');
    return all(kind);
  });
  const success: transport.ProviderResult = {
    status: 'completed',
    text: '목록과 자료를 확인했어요.',
    toolCalls: [],
    refusal: null,
    error: null,
    usage: { inputTokens: 10, outputTokens: 4, costUsd: null, raw: null, priceRevision: null },
    opaqueState: null,
  };
  let calls = 0;
  vi.spyOn(transport, 'executeProvider').mockImplementation(async (target, request, options) => {
    transport.validateConnection(target, options.approvedOrigins);
    options.beforeTurn?.();
    await options.onWire?.({
      connectionId: target.id,
      protocol: target.protocol,
      role: request.role,
      modelId: request.modelId,
      method: 'POST',
      url: target.endpoint,
      headers: {},
      body: request as unknown as transport.Json,
      bodySha256: 'synthetic',
      stablePrefixSha256: 'synthetic',
    });
    const round = calls++;
    if (round === 0) {
      expect(
        request.stable.tools.find((tool) => tool.name === 'library.search')?.inputSchema
      ).toMatchObject({
        required: ['query'],
        properties: {
          query: { maxLength: 200 },
          offset: { minimum: 0 },
          limit: { minimum: 1, maximum: 50, default: 20 },
        },
      });
      return {
        ...success,
        status: 'tool_calls',
        text: '',
        toolCalls: [
          { id: 'default-list', name: 'workspace.read', arguments: {} },
          { id: 'explicit-list', name: 'workspace.read', arguments: { kind: 'library' } },
          {
            id: 'search',
            name: 'library.search',
            arguments: { query: '자료 0 bot' },
          },
        ],
      };
    }
    const results = request.input.results as unknown as ToolEvent[];
    expect(results.every((event) => !event.denied && !event.errorKind)).toBe(true);
    expect(results.find((event) => event.callId === 'default-list')!.result).toEqual(expected);
    expect(results.find((event) => event.callId === 'explicit-list')!.result).toEqual(expected);
    const searched = results.find((event) => event.callId === 'search')!.result as ReturnType<
      Store['product']['searchLibrary']
    >;
    expect(searched).toMatchObject({ total: 1, offset: 0, nextOffset: null });
    expect(searched.items).toHaveLength(1);
    if (round === 1) {
      expect(results).toHaveLength(3);
      const item = searched.items[0]!;
      return {
        ...success,
        status: 'tool_calls',
        text: '',
        toolCalls: [
          { id: 'full-body', name: 'library.read', arguments: { id: item.id, kind: item.kind } },
        ],
      };
    }
    expect(results).toHaveLength(4);
    expect(results.find((event) => event.callId === 'full-body')!.result).toEqual(f.contents[0]);
    return success;
  });
  const task = runtime.enqueue(conversation.id, randomUUID(), '자료 목록과 첫 자료를 읽고 알려줘');
  await Promise.all(work);
  expect(runtime.workspace.task(task.id)).toMatchObject({
    status: 'completed',
    snapshot: { grants: [] },
    usage: { modelCalls: 3 },
  });
  expect(calls).toBe(3);
});
