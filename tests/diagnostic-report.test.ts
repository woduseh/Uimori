import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createDiagnosticReport, parseDiagnosticScope } from '../server/diagnostic-report.js';
import { DIAGNOSTIC_LIMITS, diagnosticError, diagnosticNumber } from '../core/diagnostic-report.js';
import { DATABASE_SCHEMA_VERSION } from '../server/database-schema.js';
import { createFixtureChat } from './fixtures/chat.js';
import type { Store } from '../server/store.js';

const owned: { directory: string; app?: Awaited<ReturnType<typeof createApp>> }[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const { directory, app } of owned.splice(0)) {
    await app?.close();
    const inside = relative(tmpdir(), directory);
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-report-'))
      throw new Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});
async function fixture(accessToken?: string) {
  const item: (typeof owned)[number] = { directory: mkdtempSync(join(tmpdir(), 'uimori-report-')) };
  owned.push(item);
  item.app = await createApp({
    dbPath: join(item.directory, 'test.sqlite'),
    buildId: 'a'.repeat(64),
    accessToken,
  });
  return item.app;
}
function runFixture(store: Store, chatId: string, marker: string) {
  const chat = store.chat(chatId);
  const { run } = store.createRun(
    chatId,
    {
      request: marker,
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current) => ({
      chatId,
      parentRevision: null,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request: marker,
      history: [],
      resources: [],
    })
  );
  store.db
    .prepare("UPDATE runs SET status='failed',error=?,partial_text=?,usage=? WHERE id=?")
    .run(
      marker,
      marker,
      JSON.stringify({ modelCalls: 2, inputTokens: null, outputTokens: 7, costUsd: null }),
      run.id
    );
  store.db
    .prepare('INSERT INTO model_inputs(run_id,input) VALUES(?,?)')
    .run(run.id, JSON.stringify({ prompt: marker, api_key: marker }));
  store.db
    .prepare('INSERT INTO tool_events(run_id,event) VALUES(?,?)')
    .run(
      run.id,
      JSON.stringify({ name: marker, args: { private: marker }, result: marker, denied: true })
    );
  const attempt = store.product.mockAttempt(chatId, run.id, null, 'main', {
    body: marker,
    endpoint: marker,
  });
  store.db
    .prepare(
      'UPDATE attempts SET connection_id=?,model_id=?,error=?,request=?,response=?,raw_usage=?,input_tokens=NULL,output_tokens=7,cost_usd=NULL WHERE id=?'
    )
    .run(
      marker,
      marker,
      'HTTP_400',
      JSON.stringify({
        protocol: 'openai-responses-v1',
        body: marker,
        headers: { authorization: marker },
        url: marker,
        bodySha256: marker,
      }),
      JSON.stringify({ text: marker, error: { message: marker, stack: marker } }),
      JSON.stringify({ private: marker }),
      attempt
    );
  return { run, attempt };
}

test('report uses explicit projections and local aliases, preserves phase evidence, and changes no stored data or provider state', async () => {
  const app = await fixture(),
    store = app.store;
  const marker = 'PRIVATE_BODY_KEY_URL_TITLE_IDENTIFIER_123';
  const chat = createFixtureChat(store, marker);
  const { run, attempt } = runFixture(store, chat.id, marker);
  const other = createFixtureChat(store, 'OTHER_PRIVATE_CHAT');
  runFixture(store, other.id, 'OTHER_PRIVATE_BODY');
  const before = store.db.prepare('SELECT total_changes() AS n').get();
  const fetch = vi.fn(() => {
    throw new Error('Provider must not be called');
  });
  vi.stubGlobal('fetch', fetch);
  const response = await app.inject({
    method: 'POST',
    url: '/api/diagnostics/report',
    payload: { scope: 'chat', chatId: chat.id, runId: run.id },
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  const report = response.json();
  expect(report.environment.schemaVersion).toBe(DATABASE_SCHEMA_VERSION);
  expect(report.runs).toEqual([
    {
      ref: 'run-1',
      status: 'failed',
      errorCode: 'UNKNOWN_ERROR',
      inputCount: 1,
      toolCount: 1,
      deniedToolCount: 1,
      sourceCommitted: false,
      hasPartialOutput: true,
      modelCalls: 2,
      inputTokens: null,
      outputTokens: 7,
      costUsd: null,
      elapsedToLastUpdateMs: 0,
    },
  ]);
  expect(report.attempts[0]).toMatchObject({
    runRef: 'run-1',
    role: 'main',
    errorCode: 'HTTP_400',
    protocol: 'openai-responses-v1',
    inputTokens: null,
    outputTokens: 7,
    costUsd: null,
  });
  for (const privateValue of [marker, chat.id, run.id, attempt, other.id, 'OTHER_PRIVATE_BODY'])
    expect(response.body).not.toContain(privateValue);
  expect(store.db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  expect(fetch).not.toHaveBeenCalled();
  expect(store.run(run.id).inputs[0]).toMatchObject({ prompt: marker });
  expect((await app.inject(`/api/attempts/${attempt}`)).json().response.text).toBe(marker);
});

test('system scope contains no chat data; invalid scopes and cross-chat runs are rejected', async () => {
  const app = await fixture(),
    store = app.store;
  const chat = createFixtureChat(store, 'scope'),
    other = createFixtureChat(store, 'other');
  const { run } = runFixture(store, chat.id, 'PRIVATE');
  const report = createDiagnosticReport(store, { scope: 'system' }, { buildId: 'PRIVATE_PATH' });
  expect(report.runs).toEqual([]);
  expect(report.attempts).toEqual([]);
  expect(report.environment.buildId).toBeNull();
  for (const payload of [
    { scope: 'chat', chatId: other.id, runId: run.id },
    { scope: 'chat', chatId: 'missing' },
  ])
    expect(
      (await app.inject({ method: 'POST', url: '/api/diagnostics/report', payload })).statusCode
    ).toBe(404);
  for (const value of [
    null,
    {},
    { scope: 'system', chatId: chat.id },
    { scope: 'chat', chatId: chat.id, body: 'PRIVATE' },
    { scope: 'chat', chatId: chat.id, runId: '' },
  ])
    expect(() => parseDiagnosticScope(value)).toThrow();
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/diagnostics/report',
        payload: { scope: 'chat', chatId: 'a'.repeat(2000) },
      })
    ).statusCode
  ).toBe(413);
});

test('report requires the existing session including encoded API paths', async () => {
  const token = 'synthetic-diagnostic-access-token-12345';
  const app = await fixture(token);
  for (const url of ['/api/diagnostics/report', '/%61pi/diagnostics/report'])
    expect(
      (await app.inject({ method: 'POST', url, payload: { scope: 'system' } })).statusCode
    ).toBe(401);
  const login = await app.inject({ method: 'POST', url: '/api/session', payload: { token } });
  expect(login.statusCode).toBe(200);
  const cookie = login.headers['set-cookie'] as string;
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/diagnostics/report',
        headers: { cookie },
        payload: { scope: 'system' },
      })
    ).statusCode
  ).toBe(200);
});

test('recent row caps, omitted links and unknown stored values remain bounded and explicit', async () => {
  const app = await fixture(),
    store = app.store;
  const chat = createFixtureChat(store, 'bounded');
  const { run } = runFixture(store, chat.id, 'PRIVATE');
  for (let i = 0; i < DIAGNOSTIC_LIMITS.attempts; i++)
    store.product.mockAttempt(chat.id, null, null, 'main', { data: 'PRIVATE' });
  store.db
    .prepare('UPDATE attempts SET role=?,status=?,error=?,request=? WHERE run_id IS NULL')
    .run('PRIVATE_ROLE', 'PRIVATE_STATUS', 'HTTP_400 PRIVATE_SECRET', '{malformed PRIVATE');
  const report = createDiagnosticReport(
    store,
    { scope: 'chat', chatId: chat.id },
    { buildId: 'a'.repeat(64) }
  );
  expect(report.coverage.attempts).toEqual({
    included: DIAGNOSTIC_LIMITS.attempts,
    truncated: true,
  });
  expect(
    report.attempts.every(
      (a) =>
        a.runRef === null &&
        a.role === 'unknown' &&
        a.status === 'unknown' &&
        a.protocol === 'unknown' &&
        a.errorCode === 'UNKNOWN_ERROR'
    )
  ).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(DIAGNOSTIC_LIMITS.bytes);
  expect(JSON.stringify(report)).not.toContain('PRIVATE');
  const maximumFields = Array.from(
    { length: 8 },
    (_, i) => `${'parameters.'.repeat(10)}messages[${100 + i}].text`
  );
  expect(maximumFields.every((field) => field.length === 128)).toBe(true);
  store.db
    .prepare('UPDATE attempts SET response=? WHERE chat_id=?')
    .run(
      JSON.stringify({ error: { diagnostic: { httpStatus: 400, fields: maximumFields } } }),
      chat.id
    );
  const fullFields = createDiagnosticReport(
    store,
    { scope: 'chat', chatId: chat.id },
    { buildId: 'a'.repeat(64) }
  );
  expect(fullFields.attempts.every((attempt) => attempt.rejectedFields.length === 8)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(fullFields))).toBeLessThan(DIAGNOSTIC_LIMITS.bytes);
  store.db.prepare('UPDATE runs SET usage=? WHERE id=?').run(
    JSON.stringify({
      modelCalls: { value: 'PRIVATE'.repeat(10000) },
      inputTokens: -5,
      outputTokens: 'PRIVATE',
      costUsd: null,
    }),
    run.id
  );
  const poisoned = createDiagnosticReport(
    store,
    { scope: 'chat', chatId: chat.id, runId: run.id },
    { buildId: 'a'.repeat(64) }
  );
  expect(poisoned.runs[0]).toMatchObject({
    modelCalls: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  });
});

test('only finite known diagnostics survive and no error suffix is forwarded', () => {
  expect(diagnosticError('HTTP_429')).toBe('HTTP_429');
  expect(diagnosticError('HTTP_429: SECRET')).toBe('UNKNOWN_ERROR');
  expect(diagnosticError('Provider outcome uncertain; not replayed')).toBe(
    'PROVIDER_OUTCOME_UNCERTAIN'
  );
  expect(diagnosticError(null)).toBeNull();
  for (const value of [NaN, Infinity, -1, '123', {}]) expect(diagnosticNumber(value)).toBeNull();
});

test('relative preparation timing and HTTP rejection paths exclude timestamps, request IDs and arbitrary provider text', async () => {
  const app = await fixture(),
    store = app.store;
  const chat = createFixtureChat(store, 'PRIVATE_CHAT');
  const first = runFixture(store, chat.id, 'PRIVATE');
  const second = store.product.mockAttempt(chat.id, first.run.id, null, 'main', {});
  for (const [id, time, fields] of [
    [first.attempt, '2026-01-02T03:04:05.000Z', ['generationConfig.temperature', 'PRIVATE_FIELD']],
    [
      second,
      '2026-01-02T03:04:06.250Z',
      ['messages[0].content', 'instructions.PRIVATE', 'parameters', 'parameters'],
    ],
  ] as const)
    store.db.prepare('UPDATE attempts SET request=?,response=? WHERE id=?').run(
      JSON.stringify({ protocol: 'deepseek-chat-v1', pricingStartedAt: time }),
      JSON.stringify({
        error: {
          diagnostic: {
            httpStatus: 400,
            fields,
            requestId: 'PRIVATE_REQUEST_ID',
            message: 'PRIVATE_MESSAGE',
          },
        },
      }),
      id
    );
  store.db
    .prepare('UPDATE runs SET created_at=?,updated_at=? WHERE id=?')
    .run('2026-01-02T03:00:00.000Z', '2026-01-02T03:05:00.000Z', first.run.id);
  const report = createDiagnosticReport(
    store,
    { scope: 'chat', chatId: chat.id, runId: first.run.id },
    { buildId: 'a'.repeat(64) }
  );
  expect(report.runs[0].elapsedToLastUpdateMs).toBe(300000);
  expect(
    report.attempts.map((a) => ({
      sequence: a.sequence,
      preparedOffsetMs: a.preparedOffsetMs,
      durationMs: a.durationMs,
      httpStatus: a.httpStatus,
      rejectedFields: a.rejectedFields,
      protocol: a.protocol,
    }))
  ).toEqual([
    {
      sequence: 2,
      preparedOffsetMs: 1250,
      durationMs: null,
      httpStatus: 400,
      rejectedFields: ['messages[0].content', 'parameters'],
      protocol: 'deepseek-chat-v1',
    },
    {
      sequence: 1,
      preparedOffsetMs: 0,
      durationMs: null,
      httpStatus: 400,
      rejectedFields: ['generationConfig.temperature'],
      protocol: 'deepseek-chat-v1',
    },
  ]);
  expect(JSON.stringify(report)).not.toContain('2026-01-02');
  expect(JSON.stringify(report)).not.toContain('PRIVATE');
});

test('Run truncation is explicit and attempt relationships never invent a missing Run', async () => {
  const app = await fixture(),
    store = app.store;
  const chat = createFixtureChat(store, 'bounded-runs');
  const first = runFixture(store, chat.id, 'first');
  for (let i = 0; i < DIAGNOSTIC_LIMITS.runs; i++) runFixture(store, chat.id, `other-${i}`);
  const report = createDiagnosticReport(
    store,
    { scope: 'chat', chatId: chat.id },
    { buildId: 'a'.repeat(64) }
  );
  expect(report.coverage.runs).toEqual({ included: DIAGNOSTIC_LIMITS.runs, truncated: true });
  expect(report.attempts.at(-1)?.runRef).toBeNull();
  const focused = createDiagnosticReport(
    store,
    { scope: 'chat', chatId: chat.id, runId: first.run.id },
    { buildId: 'a'.repeat(64) }
  );
  expect(focused.coverage.runs.truncated).toBe(false);
  expect(focused.attempts[0].runRef).toBe(focused.runs[0].ref);
});
