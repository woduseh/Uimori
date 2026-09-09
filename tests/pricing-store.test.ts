import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import type { Connection, ModelPreset } from '../core/product.js';
import type { ProviderResult, WireRecord } from '../core/transport.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { store: Store; directory: string }[] = [];
const database = () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-pricing-store-'));
  const store = new Store(join(directory, 'test.sqlite'));
  owned.push({ store, directory });
  return store;
};
afterEach(() => {
  for (const { store, directory } of owned.splice(0).reverse()) {
    store.close();
    const target = resolve(directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-pricing-store-')
    )
      throw new Error('Unsafe test cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});
const modelBody = (connectionId: string, input: number) => ({
  title: 'Synthetic priced model',
  connectionId,
  modelId: 'synthetic-pricing',
  maxOutputTokens: 512,
  temperature: null,
  pricing: { mode: 'manual', rates: { input, output: 8, cacheRead: 0.5, cacheWrite: null } },
});
const setup = () => {
  const store = database();
  const chat = createFixtureChat(store, 'Synthetic pricing');
  const connection = store.product.connection({
    title: 'Synthetic connection',
    protocol: 'openai-chat-v1',
    endpoint: 'http://127.0.0.1:19999/v1',
    enabled: true,
  }) as Connection;
  const model = store.product.model(modelBody(connection.id, 2)) as ModelPreset;
  const wire = (): WireRecord => ({
    connectionId: connection.id,
    protocol: connection.protocol,
    role: 'translation',
    modelId: model.modelId,
    method: 'POST',
    url: connection.endpoint + '/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: { model: model.modelId },
    bodySha256: 'synthetic-hash',
    stablePrefixSha256: 'synthetic-prefix',
    pricingSnapshot: store.product.modelSnapshot(model.id).pricingSnapshot,
    pricingStartedAt: '2026-09-09T12:00:00.000Z',
  });
  return { store, chat, connection, model, wire };
};
const result = (
  status: ProviderResult['status'] = 'completed',
  costUsd: number | null = null
): ProviderResult => ({
  status,
  text: 'Synthetic translation',
  toolCalls: [],
  refusal: null,
  error:
    status === 'cancelled'
      ? { code: 'CANCELLED' }
      : status === 'partial'
        ? { code: 'NETWORK_ERROR' }
        : null,
  usage: {
    inputTokens: 1000,
    outputTokens: 100,
    costUsd,
    raw: {
      prompt_tokens: 1000,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 200 },
    },
    priceRevision: null,
  },
  opaqueState: null,
});

test('stored attempt freezes reserved rates through settings changes and terminal overwrite attempts', () => {
  const { store, chat, connection, model, wire } = setup();
  const frozen = wire();
  const first = store.product.startAttempt(chat.id, null, null, frozen);
  store.product.model(
    { ...modelBody(connection.id, 4), expectedRevision: model.revision },
    model.id
  );
  store.product.finishAttempt(first, result());
  const before = store.product.attempts(chat.id)[0];
  expect(before.pricingSnapshot?.rates.input).toBe(2);
  expect(before.estimatedCost).toMatchObject({ status: 'estimated', usd: 0.0025 });
  expect(before.costUsd).toBeNull();
  expect(before.pricingStartedAt).toBe(frozen.pricingStartedAt);
  store.product.finishAttempt(first, { ...result('error', 99), text: 'Late overwritten content' });
  expect(store.product.attempts(chat.id)[0]).toEqual(before);
  const second = store.product.startAttempt(chat.id, null, null, wire());
  store.product.finishAttempt(second, result('completed', 0.123));
  const attempts = store.product.attempts(chat.id);
  expect(attempts[1].pricingSnapshot?.rates.input).toBe(4);
  expect(attempts[1].estimatedCost?.usd).toBeCloseTo(0.0041);
  expect(attempts[1].costUsd).toBe(0.123);
  expect(attempts.reduce((sum, attempt) => sum + attempt.estimatedCost!.usd!, 0)).toBeCloseTo(
    0.0066
  );
  expect(attempts[0]).toEqual(before);
});

test.each(['cancelled', 'partial'] as const)(
  '%s preserves reported usage and estimates without promoting status',
  (status) => {
    const { store, chat, wire } = setup();
    const id = store.product.startAttempt(chat.id, null, null, wire());
    store.product.finishAttempt(id, result(status));
    expect(store.product.attempts(chat.id)[0]).toMatchObject({
      status,
      costUsd: null,
      inputTokens: 1000,
      outputTokens: 100,
      estimatedCost: { status: 'estimated', usd: 0.0025 },
    });
  }
);

test('absent usage stays unknown after cancellation and provider tier mismatch is not billed with requested rates', () => {
  const { store, chat, wire } = setup();
  const id = store.product.startAttempt(chat.id, null, null, wire());
  const cancelled = result('cancelled');
  cancelled.usage = {
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    raw: null,
    priceRevision: null,
  };
  store.product.finishAttempt(id, cancelled);
  expect(store.product.attempts(chat.id)[0]).toMatchObject({
    status: 'cancelled',
    costUsd: null,
    estimatedCost: { status: 'unavailable', usd: null },
  });
  const mismatch = store.product.startAttempt(chat.id, null, null, wire());
  const response = result();
  response.usage.raw = { ...(response.usage.raw as Record<string, number>), service_tier: 'flex' };
  store.product.finishAttempt(mismatch, response);
  expect(store.product.attempts(chat.id)[1].estimatedCost).toMatchObject({
    status: 'unavailable',
    usd: null,
    notes: ['SERVICE_TIER_MISMATCH'],
  });
});

test('archive roundtrip preserves attempt frozen pricing, estimate, actual amount and source status', () => {
  const { store, chat, wire } = setup();
  const run = store.createRun(
    chat.id,
    {
      request: 'Synthetic priced request',
      expectedRevision: store.product.branch(chat.id).headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: 'synthetic-pricing-archive-run',
    },
    (current) => ({
      chatId: chat.id,
      parentRevision: current.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request: 'Synthetic priced request',
      history: [],
      resources: [],
    })
  ).run;
  const id = store.product.startAttempt(chat.id, run.id, null, { ...wire(), role: 'main' });
  store.product.finishAttempt(id, result('partial', 0.321));
  const before = store.product.attempts(chat.id);
  const restored = database();
  restored.product.import(store.product.export());
  expect(restored.product.attempts(chat.id)).toEqual(before);
  expect(restored.product.attempts(chat.id)[0]).toMatchObject({
    status: 'partial',
    costUsd: 0.321,
    estimatedCost: { status: 'estimated', usd: 0.0025 },
    pricingSnapshot: { source: 'manual', rates: { input: 2 } },
  });
});
