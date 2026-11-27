import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { z } from 'zod/v4';
import { afterEach, expect, test } from 'vitest';
import { defineEndpoint, defineOperation, endpointRequest, type OperationInput } from '#contracts';
import * as operations from '#contracts/operations';
import { checkEndpointOutputs, registerEndpoint } from '../server/endpoint.js';

const { queryBoolean, queryInt } = operations;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const echo = defineOperation(
  'test.echo',
  z.strictObject({ id: z.string(), note: z.string(), count: queryInt().optional() }),
  z.strictObject({ id: z.string(), note: z.string(), count: z.number().optional() })
);
const endpoints = {
  read: defineEndpoint<typeof echo>()({ operation: 'test.echo', method: 'GET', path: '/echo/:id' }),
  write: defineEndpoint<typeof echo>()({
    operation: 'test.echo',
    method: 'PUT',
    path: '/echo/:id',
  }),
  patch: defineEndpoint<typeof echo>()({
    operation: 'test.echo',
    method: 'PATCH',
    path: '/echo/:id',
  }),
  create: defineEndpoint<typeof echo>()({
    operation: 'test.echo',
    method: 'POST',
    path: '/echo/:id',
    status: 202,
  }),
};

async function echoApp(handler = (input: z.output<typeof echo.input>): unknown => input) {
  const app = Fastify();
  checkEndpointOutputs(app);
  for (const endpoint of Object.values(endpoints))
    registerEndpoint(
      app,
      endpoint,
      echo,
      (input) => handler(input) as z.output<typeof echo.output>
    );
  cleanup.push(() => app.close());
  return app;
}

test('the web request shape round-trips through path, query and body binding to the same input', async () => {
  const app = await echoApp();
  const input = { id: 'a b/c?', note: '쿼리 & 본문' };
  for (const [endpoint, status] of [
    [endpoints.read, 200],
    [endpoints.write, 200],
    [endpoints.patch, 200],
    [endpoints.create, 202],
  ] as const) {
    const { path, body } = endpointRequest(endpoint, input);
    const response = await app.inject({
      method: endpoint.method,
      url: `/api${path}`,
      ...(body === undefined ? {} : { payload: body }),
    });
    expect(response.statusCode, endpoint.method).toBe(status);
    expect(response.json(), endpoint.method).toEqual(input);
  }
  expect(endpointRequest(endpoints.read, { ...input, count: 3 }).path).toBe(
    '/echo/a%20b%2Fc%3F?note=%EC%BF%BC%EB%A6%AC+%26+%EB%B3%B8%EB%AC%B8&count=3'
  );
  const read = await app.inject(
    `/api${endpointRequest(endpoints.read, { ...input, count: 3 }).path}`
  );
  expect(read.json()).toEqual({ ...input, count: 3 });
});

test('the path parameter wins over a body field of the same name', async () => {
  const app = await echoApp();
  const response = await app.inject({
    method: 'PUT',
    url: '/api/echo/from-path',
    payload: { id: 'from-body', note: 'n' },
  });
  expect(response.json()).toEqual({ id: 'from-path', note: 'n' });
});

test('an unknown query or body field is refused instead of dropped', async () => {
  const app = await echoApp();
  for (const request of [
    { method: 'GET', url: '/api/echo/x?note=n&extra=1' },
    { method: 'PUT', url: '/api/echo/x', payload: { note: 'n', extra: 1 } },
  ] as const) {
    const response = await app.inject(request);
    expect(response.statusCode, request.method).toBe(400);
    expect(response.json().message, request.method).toContain('extra');
  }
});

test('test mode refuses a handler result that breaks the output schema or adds a field, and production passes it through', async () => {
  const broken = await echoApp(() => ({ id: 1 }));
  expect((await broken.inject('/api/echo/x?note=n')).statusCode).toBe(500);
  const leaking = await echoApp((input) => ({ ...input, secret: 'leak' }));
  expect((await leaking.inject('/api/echo/x?note=n')).statusCode).toBe(500);
  const production = Fastify();
  registerEndpoint(production, endpoints.read, echo, () => ({ id: 1 }) as never);
  cleanup.push(() => production.close());
  expect((await production.inject('/api/echo/x?note=n')).json()).toEqual({ id: 1 });
});

test('query helpers refuse the empty and wordy strings that coercion would turn into 0 and true', () => {
  expect(queryInt().safeParse('3').data).toBe(3);
  expect(queryInt().safeParse(3).data).toBe(3);
  for (const value of ['', ' ', '3.5', '1e3', 'abc', '-0', '01'])
    expect(queryInt().safeParse(value).success, value).toBe(false);
  expect(queryInt().safeParse('-12').data).toBe(-12);
  expect(queryInt(z.int().min(1)).safeParse('0').success).toBe(false);
  expect(queryBoolean.safeParse('false').data).toBe(false);
  expect(queryBoolean.safeParse('true').data).toBe(true);
  expect(queryBoolean.safeParse(false).data).toBe(false);
  for (const value of ['', '0', 'no', 'False'])
    expect(queryBoolean.safeParse(value).success, value).toBe(false);
});

test('a web caller passes query numbers and booleans as values, not as their wire text', () => {
  const flagged = defineOperation(
    'test.flagged',
    z.strictObject({ count: queryInt(), on: queryBoolean }),
    z.strictObject({})
  );
  const typed: OperationInput<typeof flagged>[] = [
    { count: 3, on: true },
    // @ts-expect-error the server parses '3' from the query string; the web passes a number
    { count: '3', on: true },
    // @ts-expect-error the server parses 'true' from the query string; the web passes a boolean
    { count: 3, on: 'true' },
  ];
  expect(typed).toHaveLength(3);
});

test('an endpoint path parameter must name a required string or number input key', () => {
  const optional = defineOperation(
    'test.optional',
    z.strictObject({ id: z.string().optional(), size: z.int() }),
    z.strictObject({})
  );
  defineEndpoint<typeof optional>()({
    operation: 'test.optional',
    method: 'GET',
    path: '/sizes/:size',
  });
  // @ts-expect-error the input key is id, not fontId
  defineEndpoint<typeof echo>()({ operation: 'test.echo', method: 'GET', path: '/fonts/:fontId' });
  // @ts-expect-error an optional key would request /items/undefined
  defineEndpoint<typeof optional>()({ operation: 'test.optional', method: 'GET', path: '/x/:id' });
});

function strippingObjects(root: unknown, name: string): string[] {
  const seen = new Set<unknown>();
  const found: string[] = [];
  const visit = (value: unknown, path: string) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) visit(item, `${path}[${index}]`);
      return;
    }
    seen.add(value);
    const internals = (value as { _zod?: { def?: Record<string, unknown>; innerType?: unknown } })
      ._zod;
    const def = internals?.def;
    if (!def) {
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
      return;
    }
    if (def.type === 'lazy') {
      visit(internals.innerType, path);
      return;
    }
    if (def.type === 'object') {
      if (def.catchall === undefined) found.push(path);
      for (const [key, child] of Object.entries(def.shape as object))
        visit(child, `${path}.${key}`);
      visit(def.catchall, `${path}.*`);
    }
    for (const [key, child] of Object.entries(def))
      if (key !== 'shape' && key !== 'catchall') visit(child, path);
  };
  visit(root, name);
  return found;
}

test('contract object schemas refuse unknown keys unless they opt into z.looseObject', () => {
  expect(strippingObjects(operations, 'operations')).toEqual([]);
  const tree: z.ZodType = z.lazy(() => z.strictObject({ kids: z.array(tree) }));
  expect(
    strippingObjects(
      {
        strip: z.strictObject({ nested: z.array(z.object({})) }),
        loose: z.looseObject({}),
        lazy: z.lazy(() => z.object({})),
        tree,
        catchall: z.strictObject({}).catchall(z.object({})),
      },
      'sample'
    )
  ).toEqual(['sample.strip.nested', 'sample.lazy', 'sample.catchall.*']);
});

test('invalid input answers one INVALID_REQUEST code on the app error wire and reaches no handler', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-endpoint-'));
  const { createApp } = await import('../server/app.js');
  const app = await createApp({
    dbPath: join(directory, 'app.sqlite'),
    buildId: 'endpoint-test',
    testMode: true,
  });
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanup.push(() => app.close());
  for (const request of [
    { method: 'GET', url: '/api/usage?from=2026-02-30&to=2026-03-01' },
    { method: 'GET', url: '/api/usage?from=2026-03-02&to=2026-03-01' },
    { method: 'GET', url: '/api/usage?from=2026-03-01&to=2026-03-01&group=day' },
    { method: 'GET', url: '/api/usage/export?from=2026-03-01&to=2026-03-01&group=week' },
    { method: 'PUT', url: '/api/auto-translation-defaults', payload: [] },
    {
      method: 'PUT',
      url: '/api/auto-translation-defaults',
      payload: { expectedRevision: 0, autoTranslate: true, translationLang: 'en' },
    },
    {
      method: 'PUT',
      url: '/api/font-preferences',
      payload: { expectedRevision: 0, appFontId: '', readerFontId: null },
    },
    { method: 'DELETE', url: '/api/fonts/%20%20%20' },
    {
      method: 'POST',
      url: '/api/search',
      payload: { query: 'x', scope: 'chat', kinds: ['original'] },
    },
    {
      method: 'POST',
      url: '/api/search',
      payload: { query: 'x', scope: 'workspace', chatId: 'c1', kinds: ['original'] },
    },
    { method: 'GET', url: '/api/chats/%20/bookmarks' },
    { method: 'DELETE', url: '/api/bookmarks/%20', payload: { expectedRevision: 1 } },
    { method: 'POST', url: '/api/maintenance', payload: { status: 'paused' } },
    {
      method: 'PATCH',
      url: '/api/bookmarks/b1',
      payload: { expectedRevision: 1, title: '  ', note: '' },
    },
    { method: 'GET', url: '/api/push?clientId=%20' },
    {
      method: 'PUT',
      url: '/api/backups/settings',
      payload: { expectedRevision: 0, enabled: true, hour: 3, minute: 0, retain: 0 },
    },
  ] as const) {
    const response = await app.inject(request);
    expect(response.statusCode, request.url).toBe(400);
    expect(response.json(), request.url).toEqual({ code: 'INVALID_REQUEST' });
  }
  expect((await app.inject('/api/auto-translation-defaults')).json()).toMatchObject({
    revision: 0,
    autoTranslate: false,
  });
  const settings = await app.inject('/api/backups');
  expect(settings.json().settings).toMatchObject({ revision: 0, retain: 7 });
});
