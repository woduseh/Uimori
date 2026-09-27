import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.js';
import { usageReport, usageCsv } from '../server/usage-report.js';
import { detachAttemptUsage, inferUsageKind } from '../server/usage-accounting.js';
import { deleteChat } from '../server/chat-deletion.js';
import { createFixtureChat } from './fixtures/chat.js';
import type { WireRecord, ProviderResult } from '../core/transport.js';

const owned: { store: Store; directory: string }[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-usage-'));
  const store = new Store(join(directory, 'app.sqlite'));
  owned.push({ store, directory });
  return store;
}
afterEach(() => {
  for (const item of owned.splice(0)) {
    item.store.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});
const query = { from: '2026-09-27', to: '2026-09-27' };
function wire(overrides: Partial<WireRecord> = {}): WireRecord {
  return {
    connectionId: 'recorded-provider',
    protocol: 'openai-chat-v1',
    role: 'main',
    modelId: 'usage-model',
    method: 'POST',
    url: 'https://example.invalid/private',
    headers: { 'X-Custom': 'PRIVATE_CANARY' },
    body: { prompt: 'PRIVATE_CANARY' },
    bodySha256: 'private-body',
    stablePrefixSha256: 'private-prefix',
    pricingStartedAt: '2026-09-26T15:30:00.000Z',
    pricingSnapshot: {
      version: 1,
      protocol: 'openai-chat-v1',
      modelId: 'usage-model',
      source: 'manual',
      checkedAt: '2026-09-01T00:00:00Z',
      serviceTier: 'default',
      rates: { input: 2, output: 10, cacheRead: 0, cacheWrite: null },
      notes: [],
    },
    ...overrides,
  };
}
function result(
  costUsd: number | null = null,
  status: ProviderResult['status'] = 'completed'
): ProviderResult {
  return {
    status,
    text: 'PRIVATE_CANARY output',
    toolCalls: [],
    refusal: null,
    error: status === 'error' ? { code: 'PRIVATE_CANARY diagnostic' } : null,
    opaqueState: null,
    usage: {
      inputTokens: 1000,
      outputTokens: 100,
      costUsd,
      raw: {
        prompt_tokens: 1000,
        completion_tokens: 100,
        prompt_tokens_details: { cached_tokens: 0 },
        canary: 'PRIVATE_CANARY',
      },
      priceRevision: 'PRIVATE_CANARY revision',
    },
  };
}
function add(
  store: Store,
  chatId: string | null,
  input = wire(),
  output = result(),
  at: string | null = '2026-09-26T15:30:00.000Z'
) {
  const id = store.product.startAttempt(chatId, null, null, input);
  store.product.finishAttempt(id, output);
  store.db.prepare('UPDATE attempts SET started_at=? WHERE id=?').run(at, id);
  return id;
}

test('reported values win over frozen estimates; partial, unknown, zero, failed calls, synthetic and undated records stay distinct', () => {
  const store = fixture();
  const chat = createFixtureChat(store, 'Usage');
  const reported = add(store, chat.id, wire(), result(0.5), '2026-09-26T15:00:00.000Z');
  add(store, chat.id, wire({ role: 'translation' }));
  const partial = wire();
  partial.pricingSnapshot!.rates.output = null;
  add(store, chat.id, partial, result(null, 'error'));
  add(store, chat.id, wire({ pricingSnapshot: undefined }), {
    ...result(),
    usage: { inputTokens: null, outputTokens: null, costUsd: null, raw: null, priceRevision: null },
  });
  add(store, chat.id, wire(), result(0));
  add(store, chat.id, wire(), result(9), '2026-09-27T15:00:00.000Z');
  add(store, chat.id, wire(), result(2), null);
  const mock = store.product.mockAttempt(chat.id, null, null, 'main', { fixture: true });
  store.db
    .prepare('UPDATE attempts SET started_at=?,cost_usd=1000 WHERE id=?')
    .run('2026-09-26T16:00:00Z', mock);
  const report = usageReport(store, query);
  expect(report.totals).toMatchObject({
    calls: 5,
    reportedUsd: 0.5,
    partialCalls: 1,
    unknownCostCalls: 1,
    unknownInputCalls: 1,
    unknownOutputCalls: 1,
  });
  expect(report.totals.estimatedUsd).toBeCloseTo(0.003);
  expect(report.totals.partialUsd).toBeCloseTo(0.002);
  expect(report.days).toHaveLength(1);
  expect(report.days[0].day).toBe('2026-09-27');
  expect(report.models.reduce((sum, item) => sum + item.calls, 0)).toBe(5);
  expect(report.kinds.reduce((sum, item) => sum + item.calls, 0)).toBe(5);
  expect(report.undated).toMatchObject({ calls: 1, reportedUsd: 2 });
  store.product.finishAttempt(reported, result(99));
  expect(usageReport(store, query)).toEqual(report);
  expect(() => usageReport(store, { from: '2026-02-30', to: '2026-09-27' })).toThrow();
  expect(() => usageReport(store, { from: '2026-09-28', to: '2026-09-27' })).toThrow();
});

test('deleting a conversation keeps numerical usage but removes all payloads and ownership links', () => {
  const store = fixture();
  const chat = createFixtureChat(store, 'Private story');
  add(store, chat.id, wire({ agentId: 'advisor-1' }), result(1));
  add(
    store,
    chat.id,
    wire({ judgment: { kind: 'main-refusal', inputHash: 'source-hash' } }),
    result(0.3)
  );
  const before = usageReport(store, query);
  expect(before.kinds.map((item) => item.kind).sort()).toEqual(['advisor', 'judgment']);
  deleteChat(store, chat.id, {});
  expect(usageReport(store, query)).toEqual(before);
  const rows = store.db.prepare('SELECT * FROM attempts').all();
  expect(rows).toHaveLength(2);
  for (const row of rows)
    expect(row).toMatchObject({
      chat_id: null,
      run_id: null,
      job_id: null,
      usage_detached: 1,
      error: null,
      raw_usage: null,
      request: '{}',
    });
  expect(JSON.stringify(rows)).not.toContain('PRIVATE_CANARY');
  expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

test('ephemeral input translation and a late detached completion never persist draft text or restore deleted prose', () => {
  const store = fixture();
  const chat = createFixtureChat(store, 'Ephemeral');
  const id = store.product.startAttempt(chat.id, null, null, wire(), {
    kind: 'input-translation',
    retainContent: false,
  });
  expect(
    JSON.stringify(store.db.prepare('SELECT * FROM attempts WHERE id=?').get(id))
  ).not.toContain('PRIVATE_CANARY');
  detachAttemptUsage(store.db, [id]);
  store.product.finishAttempt(id, result(0.02));
  const row = store.db.prepare('SELECT * FROM attempts WHERE id=?').get(id)!;
  expect(row).toMatchObject({
    status: 'completed',
    usage_kind: 'input-translation',
    input_tokens: 1000,
    output_tokens: 100,
    cost_usd: 0.02,
    request: '{}',
    raw_usage: null,
  });
  expect(JSON.stringify(row)).not.toContain('PRIVATE_CANARY');
  expect(Number(row.estimated_usd)).toBeCloseTo(0.003);
  expect(inferUsageKind(wire({ agentId: 'advisor' }))).toBe('advisor');
  expect(inferUsageKind(wire(), true)).toBe('unclassified');
});

test('version-eight upgrade uses only saved timestamps and attribution and does not recreate missing history', () => {
  const store = fixture();
  const chat = createFixtureChat(store, 'Old ledger');
  const id = add(store, chat.id, wire(), result(0.7));
  const undated = add(
    store,
    chat.id,
    wire({ pricingStartedAt: undefined, agentId: 'reviewer' }),
    result(0.2)
  );
  store.db
    .prepare(
      "UPDATE attempts SET request=json_set(request,'$.detailsOmitted',json('true')) WHERE id=?"
    )
    .run(id);
  const entry = owned.at(-1)!;
  store.close();
  const old = new DatabaseSync(join(entry.directory, 'app.sqlite'));
  // Push is newer than the simulated historical schema and references the later accounting columns.
  old.exec(
    'DROP TRIGGER push_main_terminal; DROP TRIGGER push_translation_terminal; DROP TRIGGER push_illustration_terminal; DROP TABLE push_outbox; DROP TABLE push_subscriptions;'
  );
  old.exec('DROP INDEX attempts_usage_period; DROP INDEX attempts_usage_model;');
  for (const column of [
    'started_at',
    'usage_kind',
    'is_synthetic',
    'usage_detached',
    'estimated_usd',
    'estimated_subtotal_usd',
    'estimate_status',
  ])
    old.exec(`ALTER TABLE attempts DROP COLUMN ${column}`);
  old.exec("DELETE FROM app_metadata WHERE key='usage-coverage-since'; PRAGMA user_version=8;");
  old.close();
  entry.store = new Store(join(entry.directory, 'app.sqlite'));
  const report = usageReport(entry.store, query);
  expect(report.totals).toMatchObject({ calls: 1, reportedUsd: 0.7 });
  expect(report.kinds[0].kind).toBe('unclassified');
  expect(report.undated).toMatchObject({ calls: 1, reportedUsd: 0.2 });
  expect(
    entry.store.db.prepare('SELECT usage_kind FROM attempts WHERE id=?').get(undated)!.usage_kind
  ).toBe('advisor');
  expect(entry.store.chat(chat.id).title).toBe(chat.title);
});

test('CSV exports one grouping, includes coverage columns and neutralizes spreadsheet formulas in model IDs', () => {
  const store = fixture();
  add(store, null, wire({ modelId: '=HYPERLINK("https://example.invalid")' }), result(0));
  const report = usageReport(store, query);
  const csv = usageCsv(report, 'model');
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  expect(csv).toContain('"\'=HYPERLINK');
  expect(csv).toContain('"비용 미확인 호출"');
  expect(csv.trim().split('\r\n')).toHaveLength(2);
  expect(csv).not.toContain('PRIVATE_CANARY');
});
