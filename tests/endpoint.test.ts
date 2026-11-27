import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { z } from 'zod';
import { afterEach, expect, test } from 'vitest';
import { defineEndpoint, defineOperation, endpointRequest } from '#contracts';
import { checkEndpointOutputs, registerEndpoint } from '../server/endpoint.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const echo = defineOperation(
  'test.echo',
  z.object({ id: z.string(), note: z.string(), count: z.coerce.number().int().optional() }),
  z.object({ id: z.string(), note: z.string(), count: z.number().optional() })
);
const endpoints = {
  read: defineEndpoint<typeof echo>({ operation: 'test.echo', method: 'GET', path: '/echo/:id' }),
  write: defineEndpoint<typeof echo>({ operation: 'test.echo', method: 'PUT', path: '/echo/:id' }),
  create: defineEndpoint<typeof echo>({
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

test('test mode refuses a handler result that breaks the output schema, and production passes it through', async () => {
  const broken = await echoApp(() => ({ id: 1 }));
  expect((await broken.inject('/api/echo/x?note=n')).statusCode).toBe(500);
  const production = Fastify();
  registerEndpoint(production, endpoints.read, echo, () => ({ id: 1 }) as never);
  cleanup.push(() => production.close());
  expect((await production.inject('/api/echo/x?note=n')).json()).toEqual({ id: 1 });
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
    { method: 'GET', url: '/api/usage/export?from=2026-03-01&to=2026-03-01&group=week' },
    { method: 'PUT', url: '/api/auto-translation-defaults', payload: [] },
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
  const settings = await app.inject('/api/backups');
  expect(settings.json().settings).toMatchObject({ revision: 0, retain: 7 });
});
