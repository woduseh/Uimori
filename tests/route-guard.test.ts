import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type RouteOptions } from 'fastify';
import { expect, test } from 'vitest';
import { z } from 'zod/v4';
import { allEndpoints, defineEndpoint, defineOperation, type Endpoint } from '#contracts';
import { createApp } from '../server/app.js';
import { endpointUrl, registerEndpoint, type RouteKind } from '../server/endpoint.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const allowlistPath = 'tests/raw-route-allowlist.json';
const allowlistFile = resolve(root, allowlistPath);
const shrinkCommand = 'UIMORI_SHRINK_ROUTES=1 npx vitest run tests/route-guard.test.ts';

type RouteGroup = 'contract' | 'raw';

const routeKindGroup: Record<RouteKind, RouteGroup> = {
  endpoint: 'contract',
  command: 'contract',
};

type CapturedRoute = {
  method: string;
  url: string;
  key: string;
  routeKind?: RouteKind;
};

type PermanentEntry = { reason: string };

type RawRouteAllowlist = {
  permanent: Record<string, PermanentEntry>;
  debt: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const routeKey = (method: string, url: string) => `${method.toUpperCase()} ${url}`;

const isApiUrl = (url: string) => url === '/api' || url.startsWith('/api/');

function expectedContractRoutes(): Map<string, string> {
  const contracts = new Map<string, string>();
  for (const endpoints of Object.values(allEndpoints)) {
    for (const endpoint of Object.values(endpoints) as Endpoint[]) {
      const key = routeKey(endpoint.method, endpointUrl(endpoint));
      if (contracts.has(key))
        throw new Error(
          `Duplicate contract route ${key} (${contracts.get(key)} and ${endpoint.operation})`
        );
      contracts.set(key, endpoint.operation);
    }
  }
  return contracts;
}

function readAllowlist(file = allowlistFile): RawRouteAllowlist {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (!isRecord(raw)) throw new Error(`${allowlistPath}: expected a JSON object`);
  const { permanent, debt, ...rest } = raw;
  if (Object.keys(rest).length)
    throw new Error(`${allowlistPath}: only "permanent" and "debt" sections are allowed`);
  if (!isRecord(permanent)) throw new Error(`${allowlistPath}: "permanent" must be an object`);
  if (!Array.isArray(debt)) throw new Error(`${allowlistPath}: "debt" must be an array`);
  const parsedPermanent: Record<string, PermanentEntry> = {};
  for (const [key, entry] of Object.entries(permanent)) {
    if (
      !isRecord(entry) ||
      typeof entry.reason !== 'string' ||
      !entry.reason.trim() ||
      Object.keys(entry).some((field) => field !== 'reason')
    )
      throw new Error(`${allowlistPath}: permanent "${key}" must have only a non-empty "reason"`);
    parsedPermanent[key] = { reason: entry.reason };
  }
  const seenDebt = new Set<string>();
  for (const key of debt) {
    if (typeof key !== 'string' || !key.trim())
      throw new Error(`${allowlistPath}: every debt entry must be a non-empty route string`);
    if (seenDebt.has(key)) throw new Error(`${allowlistPath}: duplicate debt entry "${key}"`);
    seenDebt.add(key);
  }
  return { permanent: parsedPermanent, debt };
}

function formatAllowlist(allowlist: RawRouteAllowlist): string {
  const permanent = Object.fromEntries(
    Object.entries(allowlist.permanent).sort(([left], [right]) => (left < right ? -1 : 1))
  );
  const debt = [...new Set(allowlist.debt)].sort((left, right) => (left < right ? -1 : 1));
  return `${JSON.stringify({ permanent, debt }, null, 2)}\n`;
}

function shrinkAllowlist(
  allowlist: RawRouteAllowlist,
  rawRouteKeys: ReadonlySet<string>
): RawRouteAllowlist {
  return {
    permanent: allowlist.permanent,
    debt: allowlist.debt
      .filter((key) => rawRouteKeys.has(key) && !Object.hasOwn(allowlist.permanent, key))
      .sort((left, right) => (left < right ? -1 : 1)),
  };
}

function captureRoutes(routes: CapturedRoute[]) {
  const getHandlers = new Map<string, RouteOptions['handler']>();
  return (route: RouteOptions) => {
    if (
      !Array.isArray(route.method) &&
      route.method.toUpperCase() === 'HEAD' &&
      getHandlers.get(route.url) === route.handler
    )
      return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const rawMethod of methods) {
      const method = rawMethod.toUpperCase();
      if (method === 'GET') getHandlers.set(route.url, route.handler);
      routes.push({
        method,
        url: route.url,
        key: routeKey(method, route.url),
        routeKind: route.config?.routeKind,
      });
    }
  };
}

async function bootRoutes(testMode: boolean): Promise<CapturedRoute[]> {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-route-guard-'));
  const routes: CapturedRoute[] = [];
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    app = await createApp({
      dbPath: join(directory, 'app.sqlite'),
      buildId: 'route-guard',
      testMode,
      mcpToken: 'route-guard-mcp-token-0000000000000000',
      onRoute: captureRoutes(routes),
    });
    await app.ready();
    return routes;
  } finally {
    await app?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function routeGuardErrors(
  prodRoutes: readonly CapturedRoute[],
  testRoutes: readonly CapturedRoute[],
  contracts: ReadonlyMap<string, string>,
  allowlist: RawRouteAllowlist
): string[] {
  const errors: string[] = [];
  const prodByKey = new Map<string, CapturedRoute>();
  const contractKeys = new Set<string>();
  const rawKeys = new Set<string>();

  for (const route of prodRoutes) {
    if (!isApiUrl(route.url)) continue;
    if (prodByKey.has(route.key)) {
      errors.push(`${route.key}: duplicate route registration`);
      continue;
    }
    prodByKey.set(route.key, route);
    if (route.routeKind === undefined) {
      rawKeys.add(route.key);
      continue;
    }
    const group = routeKindGroup[route.routeKind];
    if (group === 'contract') contractKeys.add(route.key);
    else if (group === 'raw') rawKeys.add(route.key);
    else errors.push(`${route.key}: unknown routeKind "${String(route.routeKind)}"`);
  }

  for (const key of contractKeys) {
    if (!contracts.has(key))
      errors.push(
        `${key}: registered with a contract routeKind but missing from allEndpoints (packages/contracts/src/endpoint-registry.ts)`
      );
  }
  for (const [key, operation] of contracts) {
    if (contractKeys.has(key)) continue;
    if (rawKeys.has(key))
      errors.push(
        `${key}: declared in allEndpoints (${operation}) but registered as a raw route; register it with registerEndpoint`
      );
    else
      errors.push(
        `${key}: declared in allEndpoints (${operation}) but not registered by createApp`
      );
  }

  const debtSet = new Set(allowlist.debt);
  for (const key of Object.keys(allowlist.permanent)) {
    if (debtSet.has(key))
      errors.push(`${allowlistPath}: "${key}" is listed in both permanent and debt`);
    if (contracts.has(key))
      errors.push(
        `${allowlistPath}: permanent "${key}" is already a contract route; remove it from ${allowlistPath}`
      );
    else if (!rawKeys.has(key))
      errors.push(
        `${allowlistPath}: permanent "${key}" is no longer registered as a raw route; update or remove its entry by hand`
      );
  }
  for (const key of allowlist.debt) {
    if (contracts.has(key))
      errors.push(
        `${allowlistPath}: debt "${key}" is now a contract route; shrink the list with ${shrinkCommand}`
      );
    else if (!rawKeys.has(key))
      errors.push(
        `${allowlistPath}: debt "${key}" is no longer registered as a raw route; shrink the list with ${shrinkCommand}`
      );
  }
  const sortedDebt = [...allowlist.debt].sort((left, right) => (left < right ? -1 : 1));
  if (allowlist.debt.some((key, index) => key !== sortedDebt[index]))
    errors.push(`${allowlistPath}: debt entries must be sorted; run ${shrinkCommand}`);

  for (const key of [...rawKeys].sort((left, right) => (left < right ? -1 : 1))) {
    if (contracts.has(key)) continue;
    if (!Object.hasOwn(allowlist.permanent, key) && !debtSet.has(key))
      errors.push(
        `${key}: unregistered raw API route; add an endpoint/operation in packages/contracts/src/domains/ and register it with registerEndpoint, or if it must stay raw (binary, stream, or SSE), add it under "permanent" in ${allowlistPath} with its reason`
      );
  }

  const testByKey = new Map<string, CapturedRoute>();
  for (const route of testRoutes) {
    if (!isApiUrl(route.url)) continue;
    if (testByKey.has(route.key)) {
      errors.push(`${route.key}: duplicate route registration in testMode`);
      continue;
    }
    testByKey.set(route.key, route);
    const prod = prodByKey.get(route.key);
    if (!prod) {
      if (!route.url.startsWith('/api/test/'))
        errors.push(`${route.key}: testMode-only route must live under /api/test/*`);
    } else if (prod.routeKind !== route.routeKind) {
      errors.push(
        `${route.key}: routeKind differs between production (${String(prod.routeKind)}) and testMode (${String(route.routeKind)})`
      );
    }
  }
  for (const key of prodByKey.keys()) {
    if (!testByKey.has(key))
      errors.push(`${key}: registered in production but missing when testMode is true`);
  }

  return errors;
}

test('every production /api route matches allEndpoints or tests/raw-route-allowlist.json, and testMode adds only /api/test/*', async () => {
  const [prodRoutes, testRoutes] = await Promise.all([bootRoutes(false), bootRoutes(true)]);
  const contracts = expectedContractRoutes();
  let allowlist = readAllowlist();
  if (process.env.UIMORI_SHRINK_ROUTES === '1') {
    const rawKeys = new Set(
      prodRoutes
        .filter(
          (route) =>
            isApiUrl(route.url) &&
            (route.routeKind === undefined || routeKindGroup[route.routeKind] === 'raw')
        )
        .map((route) => route.key)
    );
    allowlist = shrinkAllowlist(allowlist, rawKeys);
    writeFileSync(allowlistFile, formatAllowlist(allowlist));
  }
  const errors = routeGuardErrors(prodRoutes, testRoutes, contracts, allowlist);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('route guard catches unregistered raw routes, stale debt, missing contracts and misplaced testMode routes, and shrink only removes gone debt', () => {
  const contracts = new Map([['GET /api/known', 'demo.known']]);
  const prod: CapturedRoute[] = [
    { method: 'GET', url: '/api/known', key: 'GET /api/known', routeKind: 'endpoint' },
    { method: 'GET', url: '/api/blob', key: 'GET /api/blob' },
    { method: 'POST', url: '/api/new-raw', key: 'POST /api/new-raw' },
  ];
  const testOnly: CapturedRoute[] = [
    ...prod,
    { method: 'POST', url: '/api/test/ok', key: 'POST /api/test/ok' },
    { method: 'POST', url: '/api/sneaky', key: 'POST /api/sneaky' },
  ];
  const allowlist: RawRouteAllowlist = {
    permanent: {
      'GET /api/blob': { reason: 'Binary download' },
      'GET /api/gone-permanent': { reason: 'No longer exists' },
    },
    debt: ['POST /api/gone-debt'],
  };
  const errors = routeGuardErrors(prod, testOnly, contracts, allowlist);
  expect(
    errors.some((line) => line.includes('POST /api/new-raw') && line.includes('registerEndpoint'))
  ).toBe(true);
  expect(
    errors.some(
      (line) => line.includes('POST /api/gone-debt') && line.includes('UIMORI_SHRINK_ROUTES=1')
    )
  ).toBe(true);
  expect(
    errors.some((line) => line.includes('GET /api/gone-permanent') && line.includes('by hand'))
  ).toBe(true);
  expect(
    errors.some((line) => line.includes('POST /api/sneaky') && line.includes('/api/test/*'))
  ).toBe(true);
  expect(errors.some((line) => line.includes('/api/test/ok'))).toBe(false);

  const shrunk = shrinkAllowlist(allowlist, new Set(['GET /api/blob', 'POST /api/new-raw']));
  expect(shrunk.debt).toEqual([]);
  expect(Object.keys(shrunk.permanent)).toEqual(['GET /api/blob', 'GET /api/gone-permanent']);
});

test('standalone or custom HEAD routes fail while Fastify auto-generated HEAD for GET passes', async () => {
  const captured: CapturedRoute[] = [];
  const app = Fastify({ logger: false });
  app.addHook('onRoute', captureRoutes(captured));
  const op = defineOperation('demo.known', z.strictObject({}), z.strictObject({ ok: z.boolean() }));
  const ep = defineEndpoint<typeof op>()({
    operation: 'demo.known',
    method: 'GET',
    path: '/known',
  });
  registerEndpoint(app, ep, op, () => ({ ok: true }));
  app.head('/api/explicit', async () => '');
  app.get('/api/custom', { exposeHeadRoute: false }, async () => ({ ok: true }));
  app.head('/api/custom', async () => '');
  try {
    await app.ready();
  } finally {
    await app.close();
  }
  const errors = routeGuardErrors(captured, captured, new Map([['GET /api/known', 'demo.known']]), {
    permanent: { 'GET /api/custom': { reason: 'Custom GET fixture.' } },
    debt: [],
  });
  expect(
    errors.some((line) => line.includes('HEAD /api/explicit: unregistered raw API route'))
  ).toBe(true);
  expect(errors.some((line) => line.includes('HEAD /api/custom: unregistered raw API route'))).toBe(
    true
  );
  expect(errors.some((line) => line.includes('/api/known'))).toBe(false);
  expect(errors).toHaveLength(2);
});
