import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import type { ModelPreset } from '../core/product.js';
import type { WireRecord } from '../core/transport.js';
import { invokeHelperSettingsTool as call } from '../server/helper-settings-tools.js';
import { describeHelperTools } from '../server/helper-app-tools.js';
import { createFixtureChat } from './fixtures/chat.js';
import { modelWorkspace } from '../server/prompt-workspace.js';

const owned: { path: string; store: Store }[] = [];
afterEach(() => {
  for (const { path, store } of owned.splice(0)) {
    store.close();
    const within = relative(resolve(tmpdir()), resolve(path));
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-helper-pricing-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-helper-pricing-'));
  const store = new Store(join(path, 'story.sqlite'));
  owned.push({ path, store });
  const connection = store.product.connection({
    title: 'Direct provider',
    protocol: 'openai-chat-v1',
    endpoint: 'https://private.example/v1',
    credentialRef: 'PRIVATE_KEY_REF',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Author model',
    connectionId: connection.id,
    modelId: 'author-model',
    maxOutputTokens: 1024,
    temperature: null,
  }) as ModelPreset;
  return { store, model, connection };
}
const pricing = {
  mode: 'manual',
  rates: { input: 2, output: 8, cacheRead: 0, cacheWrite: null },
  sourceUrl: 'https://example.com/official-prices',
  checkedAt: '2026-10-18',
};

test('helper pricing discovery and narrow revision update preserve model settings and frozen snapshots', () => {
  const { store, model, connection } = fixture();
  expect(
    describeHelperTools({ names: ['model.pricing.read', 'model.pricing.update'] }).tools.map(
      (t) => t.name
    )
  ).toEqual(['model.pricing.read', 'model.pricing.update']);
  const before = call(store, 'model.pricing.read', { modelId: model.id });
  expect(before).toMatchObject({ revision: model.revision, effective: null });
  expect(JSON.stringify(before)).not.toContain(connection.endpoint);
  expect(JSON.stringify(before)).not.toContain('PRIVATE_KEY_REF');
  const updated = call(store, 'model.pricing.update', {
    modelId: model.id,
    expectedRevision: model.revision,
    pricing,
  });
  expect(updated).toMatchObject({
    revision: model.revision + 1,
    effective: { source: 'manual', rates: pricing.rates, checkedAt: pricing.checkedAt },
  });
  const saved = store.product.get<ModelPreset>('model', model.id);
  expect(saved).toEqual({ ...model, revision: model.revision + 1, pricing });
  const frozen = store.product.modelSnapshot(model.id).pricingSnapshot!;
  expect(() =>
    call(store, 'model.pricing.update', {
      modelId: model.id,
      expectedRevision: model.revision,
      pricing: { ...pricing, rates: { ...pricing.rates, input: 100 } },
    })
  ).toThrow('REVISION_CONFLICT');
  call(store, 'model.pricing.update', {
    modelId: model.id,
    expectedRevision: saved.revision,
    pricing: { ...pricing, rates: { ...pricing.rates, input: 7 } },
  });
  expect(frozen.rates.input).toBe(2);
  expect(store.product.modelSnapshot(model.id).pricingSnapshot?.rates.input).toBe(7);
});

test('helper rejects missing source, unsafe metadata and unrelated writable model/credential fields', () => {
  const { store, model } = fixture();
  for (const body of [
    { pricing: { mode: 'manual', rates: pricing.rates } },
    { pricing: { ...pricing, sourceUrl: 'http://bad.example' } },
    { pricing: { ...pricing, checkedAt: '2026-02-30' } },
    { pricing, credentialRef: 'EVIL' },
    { pricing, maxOutputTokens: 1 },
    { pricing: { ...pricing, endpoint: 'https://elsewhere.example' } },
  ])
    expect(() =>
      call(store, 'model.pricing.update', {
        modelId: model.id,
        expectedRevision: model.revision,
        ...body,
      })
    ).toThrow();
  expect(store.product.get<ModelPreset>('model', model.id)).toEqual(model);
});

test('backfill prices only the calls recorded without a price and marks them as priced afterwards', () => {
  const { store, model, connection } = fixture();
  const chat = createFixtureChat(store, 'Backfill');
  const record = (inputTokens: number, outputTokens: number) => {
    const snapshot = store.product.modelSnapshot(model.id);
    const id = store.product.startAttempt(chat.id, null, null, {
      connectionId: connection.id,
      modelId: model.modelId,
      role: 'main',
      protocol: 'openai-chat-v1',
      method: 'POST',
      url: 'https://provider.invalid',
      headers: {},
      body: {},
      bodySha256: 'synthetic',
      stablePrefixSha256: 'synthetic',
      ...(snapshot.pricingSnapshot ? { pricingSnapshot: snapshot.pricingSnapshot } : {}),
    });
    store.product.finishAttempt(id, {
      status: 'completed',
      text: 'done',
      toolCalls: [],
      refusal: null,
      error: null,
      opaqueState: null,
      usage: {
        inputTokens,
        outputTokens,
        costUsd: null,
        priceRevision: null,
        raw: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      },
    });
    return id;
  };
  const estimate = (id: string) =>
    store.db
      .prepare(
        "SELECT estimate_status AS status,estimated_usd AS usd,json_extract(response,'$.estimatedCost.notes') AS notes FROM attempts WHERE id=?"
      )
      .get(id);
  const unpriced = record(1_000_000, 500_000);
  expect(estimate(unpriced)).toMatchObject({ status: 'unavailable', usd: null });
  expect(() => call(store, 'model.pricing.backfill', { modelId: model.id })).toThrow(
    'PRICING_UNAVAILABLE'
  );
  call(store, 'model.pricing.update', {
    modelId: model.id,
    expectedRevision: model.revision,
    pricing,
  });
  const priced = record(1_000_000, 0);
  expect(estimate(priced)).toMatchObject({ status: 'estimated', usd: 2 });
  call(store, 'model.pricing.update', {
    modelId: model.id,
    expectedRevision: model.revision + 1,
    pricing: { ...pricing, rates: { ...pricing.rates, input: 4 } },
  });
  expect(call(store, 'model.pricing.backfill', { modelId: model.id })).toEqual({
    modelId: model.id,
    unpricedCalls: 1,
    estimatedCalls: 1,
    partialCalls: 0,
    stillUnknownCalls: 0,
    addedUsd: 8,
  });
  expect(estimate(unpriced)).toEqual({
    status: 'estimated',
    usd: 8,
    notes: '["PRICED_AFTER_CALL"]',
  });
  expect(estimate(priced)).toMatchObject({ status: 'estimated', usd: 2 });
  expect(call(store, 'model.pricing.backfill', { modelId: model.id })).toMatchObject({
    unpricedCalls: 0,
    addedUsd: 0,
  });
});

const jevPricing = {
  mode: 'manual',
  rates: { input: 0.042, output: 0, cacheRead: null, cacheWrite: null },
  sourceUrl: 'https://docs.typesafe.ai/models',
  checkedAt: '2026-11-25',
};
const jevTarget = { provider: 'typesafe', modelId: 'jev-latest' };

test('helper reads and updates judgment prices per target through the role settings revision', () => {
  const { store, model, connection } = fixture();
  const gatewayTarget = {
    provider: 'openai-compatible',
    modelId: 'synthetic/decisions',
    connectionId: connection.id,
  };
  const gatewayPricing = {
    ...jevPricing,
    rates: { input: 1, output: 0, cacheRead: 0.1, cacheWrite: null },
  };
  const before = call(store, 'model.pricing.read', { judgment: true }) as { revision: number };
  expect(before).toMatchObject({
    judgment: true,
    current: true,
    provider: 'typesafe',
    providerModelId: 'jev-latest',
    providerHost: 'api.typesafe.ai',
    protocol: 'typesafe-systemone-v1',
    rateFields: ['input', 'output'],
    pricing: null,
    effective: null,
    judgmentTarget: jevTarget,
    storedTargets: [],
  });
  const revision = before.revision;
  const unsuited = store.product.connection({
    title: 'Messages provider',
    protocol: 'anthropic-messages-v1',
    endpoint: 'https://messages.example/v1',
    credentialRef: 'MESSAGES_KEY_REF',
    enabled: true,
  });
  for (const body of [
    { pricing: jevPricing, judgmentTarget: { ...gatewayTarget, connectionId: unsuited.id } },
    { pricing: { mode: 'manual', rates: jevPricing.rates } },
    { pricing: { ...jevPricing, rates: { ...jevPricing.rates, cacheRead: 0.01 } } },
    { pricing: { mode: 'official' } },
    { pricing: jevPricing, modelId: model.id },
    { pricing: jevPricing, judgmentTarget: { ...gatewayTarget, connectionId: 'missing' } },
    { pricing: jevPricing, judgmentTarget: { provider: 'openai', modelId: 'other' } },
    { pricing: jevPricing, expectedRevision: revision + 1 },
  ])
    expect(() =>
      call(store, 'model.pricing.update', { judgment: true, expectedRevision: revision, ...body })
    ).toThrow();
  expect(
    call(store, 'model.pricing.update', {
      judgment: true,
      expectedRevision: revision,
      pricing: jevPricing,
    })
  ).toMatchObject({
    revision: revision + 1,
    current: true,
    pricing: jevPricing,
    effective: { source: 'manual', rates: jevPricing.rates, modelId: 'jev-latest' },
  });
  const gateway = call(store, 'model.pricing.update', {
    judgment: true,
    judgmentTarget: gatewayTarget,
    expectedRevision: revision + 1,
    pricing: gatewayPricing,
  });
  expect(gateway).toMatchObject({
    current: false,
    provider: 'openai-compatible',
    connectionTitle: 'Direct provider',
    providerHost: 'private.example',
    rateFields: ['input', 'cacheRead', 'output'],
    pricing: gatewayPricing,
    storedTargets: [
      { judgmentTarget: jevTarget, providerHost: 'api.typesafe.ai', pricing: jevPricing },
      {
        judgmentTarget: gatewayTarget,
        connectionTitle: 'Direct provider',
        pricing: gatewayPricing,
      },
    ],
  });
  expect(modelWorkspace(store)).toMatchObject({
    judgment: { provider: 'typesafe' },
    judgmentPricing: [
      { ...jevTarget, pricing: jevPricing },
      { ...gatewayTarget, pricing: gatewayPricing },
    ],
  });
  expect(store.product.get<ModelPreset>('model', model.id)).toEqual(model);
  call(store, 'model.pricing.update', {
    judgment: true,
    expectedRevision: revision + 2,
    pricing: null,
  });
  expect(modelWorkspace(store).judgmentPricing).toEqual([
    { ...gatewayTarget, pricing: gatewayPricing },
  ]);
});

test('judgment backfill prices only the unpriced judgment calls of the matching target, once', () => {
  const { store, model, connection } = fixture();
  const chat = createFixtureChat(store, 'Judgment backfill');
  const call_ = (
    wire: Partial<WireRecord> & Pick<WireRecord, 'protocol' | 'connectionId' | 'modelId'>,
    inputTokens: number
  ) => {
    const id = store.product.startAttempt(chat.id, null, null, {
      role: 'main',
      method: 'POST',
      url: 'https://provider.invalid',
      headers: {},
      body: {},
      bodySha256: 'synthetic',
      stablePrefixSha256: 'synthetic',
      ...wire,
    });
    store.product.finishAttempt(id, {
      status: 'completed',
      text: '',
      toolCalls: [],
      refusal: null,
      error: null,
      opaqueState: null,
      usage: {
        inputTokens,
        outputTokens: 0,
        costUsd: null,
        priceRevision: null,
        raw: { input_tokens: inputTokens, output_tokens: 0 },
      },
    });
    return id;
  };
  const judgment = { kind: 'main-refusal' as const, inputHash: 'a'.repeat(64) };
  const jev = {
    protocol: 'typesafe-systemone-v1' as const,
    connectionId: 'typesafe-judgment',
    modelId: 'jev-latest',
    judgment,
  };
  const estimate = (id: string) =>
    store.db
      .prepare(
        "SELECT estimate_status AS status,estimated_usd AS usd,json_extract(response,'$.estimatedCost.notes') AS notes FROM attempts WHERE id=?"
      )
      .get(id);
  const unpricedJev = call_(jev, 1_000_000);
  const releasedJev = call_(jev, 1_000_000);
  store.db
    .prepare(
      `UPDATE attempts SET request=json_object('protocol',json_extract(request,'$.protocol'),
        'pricingSnapshot',json_extract(request,'$.pricingSnapshot'),'detailsOmitted',json('true')) WHERE id=?`
    )
    .run(releasedJev);
  const otherTarget = call_(
    {
      protocol: 'openai-compatible-decisions-v1',
      connectionId: connection.id,
      modelId: 'jev-latest',
      judgment,
    },
    1_000_000
  );
  const chatCall = call_(
    { protocol: 'openai-chat-v1', connectionId: connection.id, modelId: model.modelId },
    1_000_000
  );
  const alreadyPriced = call_(
    {
      ...jev,
      pricingSnapshot: {
        version: 1,
        protocol: 'typesafe-systemone-v1',
        modelId: 'jev-latest',
        source: 'manual',
        checkedAt: '2026-11-01',
        serviceTier: 'default',
        rates: { input: 0.5, output: 0, cacheRead: null, cacheWrite: null },
        notes: [],
      },
    },
    1_000_000
  );
  expect(() => call(store, 'model.pricing.backfill', { judgment: true })).toThrow(
    'PRICING_UNAVAILABLE'
  );
  const { revision } = call(store, 'model.pricing.read', { judgment: true }) as {
    revision: number;
  };
  call(store, 'model.pricing.update', {
    judgment: true,
    expectedRevision: revision,
    pricing: jevPricing,
  });
  call(store, 'model.pricing.update', {
    modelId: model.id,
    expectedRevision: model.revision,
    pricing,
  });
  expect(call(store, 'model.pricing.backfill', { judgment: true })).toMatchObject({
    judgment: true,
    provider: 'typesafe',
    unpricedCalls: 2,
    estimatedCalls: 2,
    partialCalls: 0,
    stillUnknownCalls: 0,
    addedUsd: 0.084,
  });
  expect(estimate(releasedJev)).toMatchObject({ status: 'estimated', usd: 0.042 });
  expect(estimate(unpricedJev)).toEqual({
    status: 'estimated',
    usd: 0.042,
    notes: '["PRICED_AFTER_CALL"]',
  });
  expect(estimate(otherTarget)).toMatchObject({ status: 'unavailable', usd: null });
  expect(estimate(chatCall)).toMatchObject({ status: 'unavailable', usd: null });
  expect(estimate(alreadyPriced)).toMatchObject({ status: 'estimated', usd: 0.5 });
  expect(call(store, 'model.pricing.backfill', { judgment: true })).toMatchObject({
    unpricedCalls: 0,
    addedUsd: 0,
  });
  expect(estimate(unpricedJev)).toMatchObject({ status: 'estimated', usd: 0.042 });
});
