import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { ProviderBudget, parseLiveBudgetLimits, VERTEX_BUDGET_PRICE_REVISION, VERTEX_BUDGET_RESERVATION_USD, type LiveBudgetLimits } from '../server/provider-budget.js';
import { Store } from '../server/store.js';
import { createApp, type App } from '../server/app.js';
import { syntheticResources } from '../core/provider.js';
import { executeProvider, type Json, type ProviderResult, type ProviderRole, type WireRecord } from '../core/transport.js';
import type { Connection, ModelPreset } from '../core/product.js';
import type { Run } from '../core/types.js';

const ENDPOINT = 'https://aiplatform.googleapis.com/v1/projects/synthetic-budget/locations/global/publishers/google/models';
const MODEL = 'gemini-3.8-flash';
const FIXED_TIME = () => new Date('2026-09-07T00:00:00Z');
const owned: { directory: string; store?: Store; app?: App; extra?: DatabaseSync }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0).reverse()) {
    item.extra?.close(); await item.app?.close(); item.store?.close();
    const target = resolve(item.directory); const within = relative(resolve(tmpdir()), target);
    if (isAbsolute(within) || within.startsWith('..') || !basename(target).startsWith('uimori shared budget ')) throw new Error('Refusing cleanup outside owned budget fixture');
    await rm(target, { recursive: true, force: true });
  }
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
});
async function database(limits?: LiveBudgetLimits) {
  const item = { directory: await mkdtemp(join(tmpdir(), 'uimori shared budget ')) } as (typeof owned)[number]; owned.push(item);
  const path = join(item.directory, 'budget.sqlite'); const store = new Store(path); item.store = store;
  const chat = store.createChat('Synthetic budget fixture', undefined, syntheticResources);
  const persist = (wire: WireRecord) => store.product.startAttempt(chat.id, null, null, wire);
  return { item, path, store, chat, persist, budget: new ProviderBudget(store.db, limits, FIXED_TIME) };
}
const wire = (role: ProviderRole = 'main'): WireRecord => ({
  connectionId: `synthetic-${role}`, protocol: 'vertex-gemini-v1', role, modelId: MODEL, method: 'POST',
  url: `${ENDPOINT}/${MODEL}:streamGenerateContent?alt=sse`, headers: { authorization: '[REDACTED]' },
  body: { generationConfig: { maxOutputTokens: 1 } }, bodySha256: 'synthetic-hash', stablePrefixSha256: 'synthetic-prefix',
});
const terminal = (changes: Partial<ProviderResult> = {}): ProviderResult => ({
  status: 'completed', text: 'Synthetic completion', toolCalls: [], refusal: null, error: null, opaqueState: null,
  usage: { inputTokens: 100, outputTokens: 25, costUsd: null, priceRevision: null,
    raw: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 125 } }, ...changes,
});

test('live limits are explicit positive request and USD ceilings with no guessed defaults', () => {
  expect(parseLiveBudgetLimits({})).toBeUndefined();
  expect(parseLiveBudgetLimits({ NR_LIVE_MAX_REQUESTS: '3', NR_LIVE_MAX_USD: '6.193152' })).toEqual({ maxRequests: 3, maxCostUsd: 6.193152 });
  for (const env of [
    { NR_LIVE_MAX_REQUESTS: '0', NR_LIVE_MAX_USD: '5' }, { NR_LIVE_MAX_REQUESTS: '1', NR_LIVE_MAX_USD: '0' },
    { NR_LIVE_MAX_REQUESTS: '1.5', NR_LIVE_MAX_USD: '5' }, { NR_LIVE_MAX_REQUESTS: '1' }, { NR_LIVE_MAX_USD: '5' },
    { NR_LIVE_MAX_REQUESTS: '1', NR_LIVE_MAX_USD: '' }, { NR_LIVE_MAX_REQUESTS: '1', NR_LIVE_MAX_USD: 'NaN' },
    { NR_LIVE_MAX_REQUESTS: '1', NR_LIVE_MAX_USD: 'Infinity' }, { NR_LIVE_MAX_REQUESTS: '1', NR_LIVE_MAX_USD: '0x10' },
    { NR_LIVE_MAX_REQUESTS: '-1', NR_LIVE_MAX_USD: '5' }, { NR_LIVE_MAX_REQUESTS: '9007199254740992', NR_LIVE_MAX_USD: '5' },
  ]) expect(() => parseLiveBudgetLimits(env)).toThrow('INVALID_LIVE_BUDGET');
});

test('fixture calls bypass live admission and an unconfigured live call creates no attempt or model fetch', async () => {
  const { store, chat, persist, budget } = await database();
  budget.start({ ...wire(), protocol: 'fixture-sse-v1' }, persist);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const result = await executeProvider({ id: 'synthetic', protocol: 'vertex-gemini-v1', endpoint: ENDPOINT, credentialEnv: 'NARRATIVE_PROVIDER_BUDGET_FIXTURE' }, {
    role: 'main', modelId: MODEL, stable: { contract: 'Synthetic fixture only.', tools: [] },
    generation: { maxOutputTokens: 1, temperature: null }, input: { task: 'A synthetic scene.', controls: {} },
  }, { approvedOrigins: ['https://aiplatform.googleapis.com'], signal: new AbortController().signal, resolveCredential: () => 'synthetic-not-a-real-key',
    onWire: value => { budget.start(value, persist); } });
  expect(result).toMatchObject({ status: 'error', error: { code: 'LIVE_BUDGET_NOT_CONFIGURED' } });
  expect(fetch).not.toHaveBeenCalled(); expect(store.product.attempts(chat.id)).toHaveLength(1);
});

test('reserves the full model envelope at gross rates and honors the exact decimal ceiling', async () => {
  expect(VERTEX_BUDGET_RESERVATION_USD).toBe(2.064384);
  const { store, chat, persist } = await database();
  expect(() => new ProviderBudget(store.db, { maxRequests: 9, maxCostUsd: 2.064383999 }, FIXED_TIME).start(wire(), persist)).toThrow('LIVE_COST_BUDGET_EXHAUSTED');
  const budget = new ProviderBudget(store.db, { maxRequests: 9, maxCostUsd: 2.064384 }, FIXED_TIME);
  const request = wire(); budget.start(request, persist);
  expect(request).not.toHaveProperty('budgetReservation');
  expect(store.product.attempts(chat.id)[0]).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null, priceRevision: null,
    request: { budgetReservation: { maxCostUsd: 2.064384, priceRevision: VERTEX_BUDGET_PRICE_REVISION, basis: 'gross-published-rate-upper-bound' } } });
  expect(() => budget.start(wire('translation'), persist)).toThrow('LIVE_COST_BUDGET_EXHAUSTED');
  expect(store.product.attempts(chat.id)).toHaveLength(1);
});

test('every role shares one durable request count and restart does not reset it', async () => {
  const { item, store, path, chat, persist, budget } = await database({ maxRequests: 3, maxCostUsd: 20 });
  const results = await Promise.allSettled((['main', 'translation', 'status', 'image'] as const).map(role => Promise.resolve().then(() => budget.start(wire(role), persist))));
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'rejected']);
  expect(String((results[3] as PromiseRejectedResult).reason)).toContain('LIVE_REQUEST_BUDGET_EXHAUSTED');
  expect(store.product.attempts(chat.id).map(attempt => attempt.role)).toEqual(['main', 'translation', 'status']);
  store.close(); item.store = undefined;
  const reopened = new Store(path); item.store = reopened;
  const restarted = new ProviderBudget(reopened.db, { maxRequests: 3, maxCostUsd: 20 }, FIXED_TIME);
  expect(() => restarted.start(wire(), admitted => reopened.product.startAttempt(chat.id, null, null, admitted))).toThrow('LIVE_REQUEST_BUDGET_EXHAUSTED');
  expect(reopened.product.attempts(chat.id)).toHaveLength(3);
});

test('a competing SQLite connection cannot reserve against an uncommitted attempt', async () => {
  const { item, store, path, chat, persist, budget } = await database({ maxRequests: 1, maxCostUsd: 10 });
  const other = new DatabaseSync(path); item.extra = other; other.exec('PRAGMA busy_timeout=0');
  const contender = new ProviderBudget(other, { maxRequests: 1, maxCostUsd: 10 }, FIXED_TIME);
  let competingPersistence = 0;
  budget.start(wire(), admitted => {
    const id = persist(admitted);
    expect(() => contender.start(wire('translation'), () => { competingPersistence++; return 'impossible'; })).toThrow(/locked|busy/iu);
    return id;
  });
  expect(() => contender.start(wire('translation'), () => { competingPersistence++; return 'impossible'; })).toThrow('LIVE_REQUEST_BUDGET_EXHAUSTED');
  expect(competingPersistence).toBe(0); expect(store.product.attempts(chat.id)).toHaveLength(1);
});

test('attempt insert and reservation roll back together when persistence fails', async () => {
  const { store, chat, persist, budget } = await database({ maxRequests: 1, maxCostUsd: 2.064384 });
  expect(() => budget.start(wire(), admitted => { persist(admitted); throw new Error('Synthetic insert failure'); })).toThrow('Synthetic insert failure');
  expect(store.product.attempts(chat.id)).toHaveLength(0);
  budget.start(wire('translation'), persist); expect(store.product.attempts(chat.id)).toHaveLength(1);
});

for (const status of ['completed', 'tool_calls', 'refused'] as const) test(`${status} with explicit consistent usage releases only to a gross estimate and preserves unknown actual cost`, async () => {
  // First request estimate: 100*1.50/M + 25*7.50/M = $0.0003375.
  const { store, chat, persist, budget } = await database({ maxRequests: 3, maxCostUsd: 2.0647215 });
  const result = terminal({ status }); const id = budget.start(wire(), persist); store.product.finishAttempt(id, result);
  budget.start(wire('translation'), persist);
  const saved = store.product.attempts(chat.id)[0];
  expect(saved).toMatchObject({ status, inputTokens: 100, outputTokens: 25, costUsd: null, priceRevision: null, rawUsage: result.usage.raw });
  expect(() => budget.start(wire(), persist)).toThrow('LIVE_COST_BUDGET_EXHAUSTED');
});

test('explicit zero usage can release a completed reservation while unknown usage cannot', async () => {
  const { store, persist, budget } = await database({ maxRequests: 3, maxCostUsd: 2.064384 });
  const id = budget.start(wire(), persist);
  store.product.finishAttempt(id, terminal({ usage: { inputTokens: 0, outputTokens: 0, costUsd: null, priceRevision: null,
    raw: { promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 0 } } }));
  const unknown = budget.start(wire('translation'), persist);
  store.product.finishAttempt(unknown, terminal({ usage: { inputTokens: null, outputTokens: null, costUsd: null, priceRevision: null, raw: null } }));
  expect(() => budget.start(wire(), persist)).toThrow('LIVE_COST_BUDGET_EXHAUSTED');
});

for (const status of ['running', 'partial', 'error', 'cancelled', 'interrupted']) test(`${status} retains its full reservation even with token counts`, async () => {
  const { store, persist, budget } = await database({ maxRequests: 2, maxCostUsd: 2.1 });
  const id = budget.start(wire(), persist); store.product.finishAttempt(id, terminal());
  store.db.prepare('UPDATE attempts SET status=? WHERE id=?').run(status, id);
  expect(() => budget.start(wire('translation'), persist)).toThrow('LIVE_COST_BUDGET_EXHAUSTED');
});

for (const [name, raw] of Object.entries<Json>({
  missingThoughts: { promptTokenCount: 100, candidatesTokenCount: 25, totalTokenCount: 125 },
  missingTotal: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5 },
  wrongTotal: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 126 },
  wrongOutput: { promptTokenCount: 100, candidatesTokenCount: 19, thoughtsTokenCount: 5, totalTokenCount: 125 },
  excessiveCached: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 125, cachedContentTokenCount: 101 },
  extraToolPrompt: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 125, toolUsePromptTokenCount: 5 },
})) test(`terminal ${name} cannot release a reservation`, async () => {
  const { store, persist, budget } = await database({ maxRequests: 2, maxCostUsd: 2.1 });
  const id = budget.start(wire(), persist); store.product.finishAttempt(id, terminal({ usage: { ...terminal().usage, raw } }));
  expect(() => budget.start(wire('translation'), persist)).toThrow('LIVE_COST_BUDGET_EXHAUSTED');
});

test('legacy usage retains full cost, unknown model or price history blocks admission', async () => {
  const { store, persist, budget } = await database({ maxRequests: 2, maxCostUsd: 2.1 });
  const id = persist(wire()); store.product.finishAttempt(id, terminal());
  expect(() => budget.start(wire(), persist)).toThrow('LIVE_COST_BUDGET_EXHAUSTED');
  store.db.prepare('UPDATE attempts SET model_id=? WHERE id=?').run('unpriced-model', id);
  expect(() => budget.start(wire(), persist)).toThrow('LIVE_BUDGET_HISTORY_UNVERIFIABLE');
  store.db.prepare('UPDATE attempts SET model_id=?,request=? WHERE id=?').run(MODEL, JSON.stringify({ ...wire(), budgetReservation: { maxCostUsd: 2.064384, priceRevision: 'unverified-revision' } }), id);
  expect(() => budget.start(wire(), persist)).toThrow('LIVE_BUDGET_HISTORY_UNVERIFIABLE');
});

for (const [time, permitted] of [
  ['2026-09-01T23:59:59.999Z', false], ['2026-09-02T00:00:00Z', true],
  ['2026-12-31T23:59:59.999Z', true], ['2027-01-01T00:00:00Z', false], ['invalid', false],
] as const) test(`pricing validity boundary ${time}`, async () => {
  const { store, persist } = await database();
  const budget = new ProviderBudget(store.db, { maxRequests: 1, maxCostUsd: 3 }, () => new Date(time));
  if (permitted) expect(budget.start(wire(), persist)).toEqual(expect.any(String));
  else expect(() => budget.start(wire(), persist)).toThrow('LIVE_PRICE_REVERIFY_REQUIRED');
});

test('app main, auxiliary, candidate and explicit retry all pass through the shared admission gate', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(FIXED_TIME());
  vi.stubEnv('NARRATIVE_PROVIDER_BUDGET_FIXTURE', 'synthetic-not-a-real-key');
  const providerFetch = vi.fn(async () => new Response(`data: ${JSON.stringify({
    candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'A synthetic keeper watched the evening tide.' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 125 },
  })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
  vi.stubGlobal('fetch', providerFetch);
  const item = { directory: await mkdtemp(join(tmpdir(), 'uimori shared budget ')) } as (typeof owned)[number]; owned.push(item);
  const app = await createApp({ dbPath: join(item.directory, 'app.sqlite'), buildId: 'synthetic-budget-fixture',
    approvedOrigins: ['https://aiplatform.googleapis.com'], liveBudget: { maxRequests: 1, maxCostUsd: 10 } }); item.app = app;
  const chat = app.store.createChat('Synthetic budget app', undefined, syntheticResources);
  const settings = app.store.settings(chat.id, chat.settingsRevision, { ...chat.settings, translation: true, status: false });
  const connection = app.store.product.connection({ title: 'Synthetic Vertex fetch fixture', protocol: 'vertex-gemini-v1', endpoint: ENDPOINT, enabled: true, credentialEnv: 'NARRATIVE_PROVIDER_BUDGET_FIXTURE' }) as Connection;
  const model = app.store.product.model({ title: 'Synthetic Vertex route', connectionId: connection.id, connectionRevision: connection.revision, modelId: MODEL, maxOutputTokens: 100, temperature: null }) as ModelPreset;
  const prior = app.store.product.profile(chat.id); const reference = { id: model.id, revision: model.revision };
  const profile = app.store.product.updateProfile(chat.id, { expectedRevision: prior.revision, attachments: [], creative: prior.creative,
    routes: { ...prior.routes, main: reference, translation: reference }, image: false });
  const response = await app.inject({ method: 'POST', url: `/api/chats/${chat.id}/runs`, payload: { request: 'Synthetic scene', expectedRevision: null, expectedSettingsRevision: settings.settingsRevision, expectedProfileRevision: profile.revision, idempotencyKey: randomUUID() } });
  expect(response.statusCode).toBe(200); const run = response.json<Run>();
  await expect.poll(() => app.store.run(run.id).status).toBe('completed');
  expect(app.store.detail(chat.id).jobs).toHaveLength(0);
  const translation = await app.inject({ method: 'POST', url: `/api/sources/${app.store.run(run.id).sourceRevision}/translation`, payload: {} });
  expect(translation.statusCode).toBe(200);
  await expect.poll(() => app.store.detail(chat.id).jobs[0]?.status).toBe('failed');
  const job = app.store.detail(chat.id).jobs[0]!;
  const retry = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry`, payload: {} });
  expect(retry.statusCode).toBe(200);
  await expect.poll(() => app.store.detail(chat.id).jobs[0]?.status).toBe('failed');
  const candidate = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/candidate`, payload: { idempotencyKey: randomUUID() } });
  expect(candidate.statusCode).toBe(200);
  await expect.poll(() => app.store.run(candidate.json<Run>().id).status).toBe('failed');
  expect(providerFetch).toHaveBeenCalledTimes(1);
  expect(app.store.product.attempts(chat.id)).toHaveLength(1);
  expect(app.store.product.attempts(chat.id)[0]).toMatchObject({ role: 'main', status: 'completed', costUsd: null, priceRevision: null });
  expect(app.store.detail(chat.id).sources).toHaveLength(1);
});

test('only genuine loopback and scripted fixtures are excluded from live accounting', async () => {
  const { store, chat, persist, budget } = await database({ maxRequests: 1, maxCostUsd: 10 });
  persist({ ...wire(), protocol: 'fixture-sse-v1', url: 'http://127.0.0.1:9/fixture' });
  store.product.mockAttempt(chat.id, null, null, 'main', { synthetic: true });
  budget.start(wire(), persist);
  expect(store.product.attempts(chat.id)).toHaveLength(3);
  expect(() => budget.start(wire('translation'), persist)).toThrow('LIVE_REQUEST_BUDGET_EXHAUSTED');
});

for (const [name, changes] of Object.entries<Record<string, Json>>({
  vertexWithMockFlag: { mock: true },
  remoteDisguisedAsFixture: { protocol: 'fixture-sse-v1' },
  reservedFixture: { protocol: 'fixture-sse-v1', url: 'http://127.0.0.1:9/fixture', budgetReservation: { maxCostUsd: 2.064384, priceRevision: VERTEX_BUDGET_PRICE_REVISION } },
  differentConnection: { connectionId: 'different-connection' },
  differentModel: { modelId: 'different-model' },
})) test(`mixed imported history ${name} cannot bypass admission`, async () => {
  const { store, persist, budget } = await database({ maxRequests: 2, maxCostUsd: 10 });
  const id = persist(wire());
  store.db.prepare('UPDATE attempts SET request=? WHERE id=?').run(JSON.stringify({ ...wire(), ...changes }), id);
  expect(() => budget.start(wire('translation'), persist)).toThrow('LIVE_BUDGET_HISTORY_UNVERIFIABLE');
});

test('read-only snapshots share admission accounting without changing attempts or replacing actual cost', async () => {
  const { store, persist, budget } = await database({ maxRequests: 3, maxCostUsd: 3 });
  expect(budget.snapshot()).toMatchObject({ requestCount: 0, accountedCostUsd: 0, nextRequestAdmissible: true, blockedReason: null });
  const first = budget.start(wire(), persist); store.product.finishAttempt(first, terminal());
  budget.start(wire('translation'), persist);
  const changes = () => store.db.prepare('SELECT total_changes() AS count').get(); const before = changes();
  expect(budget.snapshot()).toMatchObject({ requestCount: 2, accountedCostUsd: 2.0647215, fullReservationCount: 1,
    fullReservationCostUsd: 2.064384, usageAdjustedCount: 1, usageAdjustedEstimateUsd: 0.0003375,
    nextRequestAdmissible: false, blockedReason: 'LIVE_COST_BUDGET_EXHAUSTED' });
  expect(changes()).toEqual(before);
  expect(() => budget.start(wire('status'), persist)).toThrow('LIVE_COST_BUDGET_EXHAUSTED');
});

const flexWire = (role: ProviderRole = 'main'): WireRecord => ({ ...wire(role), headers: {authorization:'[REDACTED]', 'x-vertex-ai-llm-request-type':'shared', 'x-vertex-ai-llm-shared-request-type':'flex'} });
test('Flex uses half gross price only after confirmed traffic, while prior Standard history keeps its rate', async () => {
  const { store,persist,budget } = await database({maxRequests:1000,maxCostUsd:100});
  store.product.finishAttempt(budget.start(wire(),persist),terminal());
  const flexResult = terminal(); flexResult.usage.raw = {...flexResult.usage.raw as object,trafficType:'ON_DEMAND_FLEX'};
  store.product.finishAttempt(budget.start(flexWire('translation'),persist),flexResult);
  expect(budget.snapshot()).toMatchObject({requestCount:2,maxRequests:1000,maxCostUsd:100,usageAdjustedEstimateUsd:0.00050625,fullReservationCount:0});
  const reloaded = new ProviderBudget(store.db,{maxRequests:1000,maxCostUsd:100},FIXED_TIME);
  expect(reloaded.snapshot()).toEqual(budget.snapshot());
});
test.each([undefined,'ON_DEMAND'])('unconfirmed Flex traffic %s retains the full conservative reservation', async trafficType => {
  const {store,persist,budget} = await database({maxRequests:1000,maxCostUsd:100});
  const result = terminal(); result.usage.raw = {...result.usage.raw as object,...(trafficType?{trafficType}:{})};
  store.product.finishAttempt(budget.start(flexWire(),persist),result);
  expect(budget.snapshot()).toMatchObject({requestCount:1,fullReservationCount:1,accountedCostUsd:VERTEX_BUDGET_RESERVATION_USD});
});
test('other explicit native connections record unknown billing without consuming the Vertex test envelope', async () => {
  const {store,persist,budget} = await database({maxRequests:1000,maxCostUsd:100});
  const native:WireRecord={...wire(),protocol:'openai-responses-v1',modelId:'synthetic-model',url:'https://api.openai.com/v1/responses'};
  const id=budget.start(native,persist); store.product.finishAttempt(id,terminal());
  expect(budget.snapshot()).toMatchObject({requestCount:0,accountedCostUsd:0});
  const row=store.db.prepare('SELECT request,cost_usd FROM attempts WHERE id=?').get(id)!;
  expect(JSON.parse(String(row.request))).toMatchObject({externalBilling:'not-estimated'});expect(row.cost_usd).toBeNull();
  const compatible=budget.start({...native,url:'https://unapproved.example/v1/responses'},persist);store.product.finishAttempt(compatible,terminal());
  expect(budget.snapshot()).toMatchObject({requestCount:0,accountedCostUsd:0});
});
