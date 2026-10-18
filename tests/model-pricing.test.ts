import { expect, test } from 'vitest';
import type { Connection, ModelPreset, ProviderProtocol } from '../core/product.js';
import {
  resolveModelPricing,
  validateModelPricing,
  validatePricingSnapshot,
} from '../core/model-pricing.js';
import type { TokenRates } from '../core/pricing-types.js';

const connection = (protocol: ProviderProtocol, endpoint: string): Connection => ({
  id: 'c',
  revision: 1,
  title: 'Synthetic',
  protocol,
  endpoint,
  enabled: true,
  catalog: [],
  catalogError: null,
});
const openai = connection('openai-responses-v1', 'https://api.openai.com/v1');
const vertex = connection(
  'vertex-gemini-v1',
  'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models'
);
const at = '2026-09-09T12:00:00.000Z';
const resolve = (modelId: string, c = openai, changes: Partial<ModelPreset> = {}, now = at) =>
  resolveModelPricing({ modelId, ...changes }, c, now);
const r: TokenRates = { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 };

test('manual Flex alternatives survive a standard reservation without being inferred or mutated', () => {
  const flexRates = { ...r, input: 1, output: 3 };
  const snapshot = resolve('custom', vertex, { pricing: { mode: 'manual', rates: r, flexRates } })!;
  expect(snapshot).toMatchObject({ rates: r, standardRates: r, flexRates });
  expect(validatePricingSnapshot(snapshot)).toEqual(snapshot);
  expect(snapshot.flexRates).not.toBe(flexRates);
  expect(
    resolve('custom', vertex, { pricing: { mode: 'manual', rates: r } })?.flexRates
  ).toBeUndefined();
});

test('unknown models, custom endpoints, regions, wrong adapters and Codex have no automatic USD price', () => {
  for (const c of [
    connection('openai-responses-v1', 'https://proxy.example/v1'),
    connection('openai-responses-v1', 'https://api.openai.com/v1/custom'),
    connection('openai-responses-v1', 'https://api.openai.com/v1?region=eu'),
    connection('codex-app-server-v1', 'codex://local'),
    connection('fixture-sse-v1', 'http://127.0.0.1:9'),
  ])
    expect(resolve('gpt-5.6-sol', c)).toBeUndefined();
  expect(resolve('gpt-5.6-sol-experimental')).toBeUndefined();
  expect(
    resolve(
      'gemini-3.8-flash',
      connection('vertex-gemini-v1', vertex.endpoint.replace('/global/', '/us-central1/'))
    )
  ).toBeUndefined();
  expect(
    resolve(
      'gemini-3.8-flash',
      connection('vertex-gemini-v1', 'https://generativelanguage.googleapis.com/v1beta')
    )
  ).toBeUndefined();
});

test('Gateway uses catalog rates only at standard tier and never discounts an already tiered reference twice', () => {
  const c = connection('vercel-chat-v1', 'https://ai-gateway.vercel.sh/v1');
  expect(resolve('openai/gpt-5.6-sol', c)).toBeUndefined();
  c.catalog = [
    {
      id: 'openai/gpt-5.6-sol',
      name: 'Sol',
      capabilities: {},
      priceRevision: null,
      pricing: { rates: r, longContext: { aboveInputTokens: 272000, rates: { ...r, input: 8 } } },
    },
  ];
  c.catalogUpdatedAt = at;
  expect(resolve('openai/gpt-5.6-sol', c)).toMatchObject({
    source: 'catalog',
    rates: r,
    checkedAt: at,
    longContext: { aboveInputTokens: 272000 },
  });
  expect(resolve('openai/gpt-5.6-sol', c, { serviceTier: 'flex' })).toBeUndefined();
});

test('manual rates support unknown endpoints with separately specified Flex rates and keep null distinct from zero', () => {
  const c = connection('openai-chat-v1', 'https://custom.example/v1');
  const rates = { input: 0, cacheRead: null, cacheWrite: null, output: 2 };
  expect(resolve('custom', c, { pricing: { mode: 'manual', rates } })).toMatchObject({
    source: 'manual',
    rates,
    checkedAt: at,
  });
  expect(
    resolve('custom', c, { serviceTier: 'flex', pricing: { mode: 'manual', rates } })
  ).toBeUndefined();
  expect(
    resolve('custom', c, { serviceTier: 'flex', pricing: { mode: 'manual', rates, flexRates: r } })
      ?.rates
  ).toEqual(r);
});

test('Gateway explicit service tier rates are selected as published without a second Flex discount', () => {
  const c = connection('vercel-chat-v1', 'https://ai-gateway.vercel.sh/v1');
  const flexRates = { input: 1, cacheRead: 0.1, cacheWrite: null, output: 5 };
  c.catalog = [
    {
      id: 'openai/gpt-5.6-sol',
      name: 'Sol',
      capabilities: {},
      priceRevision: null,
      pricing: {
        rates: { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
        serviceTiers: {
          flex: {
            rates: flexRates,
            longContext: {
              aboveInputTokens: 272000,
              rates: { input: 2, cacheRead: 0.2, cacheWrite: null, output: 7.5 },
            },
          },
        },
      },
    },
  ];
  const result = resolve('openai/gpt-5.6-sol', c, { serviceTier: 'flex' });
  expect(result).toMatchObject({
    source: 'catalog',
    rates: flexRates,
    standardRates: { input: 2, output: 10 },
    flexRates,
    longContext: { aboveInputTokens: 272000, rates: { input: 2, output: 7.5 } },
  });
  expect(resolve('openai/gpt-5.6-sol', c, { serviceTier: 'priority' })).toBeUndefined();
  expect(resolve('openai/gpt-5.6-sol', c, { serviceTier: 'toString' })).toBeUndefined();
});

test('strict pricing validation rejects unknown fields, missing buckets and invalid numbers across nested structures', () => {
  for (const invalid of [-1, Infinity, NaN, 1e6 + 1, '4', undefined])
    expect(() =>
      validateModelPricing({ mode: 'manual', rates: { ...r, input: invalid } })
    ).toThrow();
  expect(validateModelPricing({ mode: 'manual', rates: { ...r, input: null } })).toMatchObject({
    rates: { input: null },
  });
  expect(() => validateModelPricing({ mode: 'official', rates: r })).toThrow();
  expect(() => validateModelPricing({ mode: 'manual', rates: { ...r, secret: 1 } })).toThrow();
  const valid = resolve('custom', openai, { pricing: { mode: 'manual', rates: r } })!;
  expect(validatePricingSnapshot(valid)).toEqual(valid);
  for (const extra of [
    { version: 2 },
    { protocol: 'unknown' },
    { checkedAt: 'bad-date' },
    { checkedAt: '2026-02-30' },
    { sourceUrl: 'http://unsafe.example' },
    { longContext: { aboveInputTokens: 0, rates: r } },
    { schedule: { peakRates: r, weekdays: [1, 1], utcHours: [[1, 4]] } },
    { schedule: { peakRates: r, weekdays: [1], utcHours: [[4, 1]] } },
    { rates: { ...r, cacheRead: Infinity } },
  ])
    expect(() => validatePricingSnapshot({ ...valid, ...extra })).toThrow();
});

test('built-in manufacturer tables are retired even for exact official endpoints and known IDs', () => {
  for (const [protocol, endpoint, modelId] of [
    ['openai-responses-v1', 'https://api.openai.com/v1', 'gpt-5.6-sol'],
    ['anthropic-messages-v1', 'https://api.anthropic.com/v1', 'claude-opus-5-5'],
    ['deepseek-chat-v1', 'https://api.deepseek.com/v1', 'deepseek-v4-pro'],
    ['google-gemini-v1', 'https://generativelanguage.googleapis.com/v1beta', 'gemini-3.8-flash'],
    ['vertex-gemini-v1', vertex.endpoint, 'gemini-3.1-pro-preview'],
  ] as const) {
    const c = connection(protocol, endpoint);
    c.catalog = [
      { id: modelId, name: modelId, capabilities: {}, priceRevision: null, pricing: { rates: r } },
    ];
    expect(resolve(modelId, c)).toBeUndefined();
    expect(resolve(modelId, c, { pricing: { mode: 'official' } })).toBeUndefined();
  }
});

test('manual source, long context and explicit Batch rates freeze without inferring discounts', () => {
  const c = connection('anthropic-messages-v1', 'https://api.anthropic.com/v1');
  const pricing = {
    mode: 'manual' as const,
    rates: { ...r },
    sourceUrl: 'https://example.com/pricing',
    checkedAt: '2026-10-18',
    longContext: { aboveInputTokens: 200000, rates: { ...r, input: 9 } },
  };
  expect(resolve('custom', c, { pricing })).toMatchObject({
    source: 'manual',
    sourceUrl: pricing.sourceUrl,
    checkedAt: pricing.checkedAt,
    longContext: pricing.longContext,
  });
  expect(resolve('custom', c, { pricing, executionMode: 'batch' })).toBeUndefined();
  const batchRates = { ...r, input: 1.5, output: 7 };
  expect(
    resolve('custom', c, { pricing: { ...pricing, batchRates }, executionMode: 'batch' })
  ).toMatchObject({
    serviceTier: 'batch',
    rates: batchRates,
  });
  const frozen = resolve('custom', c, { pricing })!;
  pricing.rates.input = 99;
  expect(frozen.rates.input).toBe(4);
  for (const extra of [
    { sourceUrl: 'http://bad.example' },
    { checkedAt: '2026-02-30' },
    { flexLongContext: { aboveInputTokens: 1, rates: r } },
    { longContext: { aboveInputTokens: 0, rates: r } },
  ])
    expect(() => validateModelPricing({ ...pricing, ...extra })).toThrow();
});

test('legacy official execution snapshots remain readable byte-for-value without current rate lookup', () => {
  const legacy = {
    version: 1,
    protocol: 'openai-responses-v1',
    modelId: 'old',
    source: 'official',
    checkedAt: '2026-09-09',
    serviceTier: 'default',
    rates: r,
    schedule: { peakRates: r, weekdays: [1], utcHours: [[1, 4]] },
    notes: ['historical'],
  };
  expect(validatePricingSnapshot(legacy)).toEqual(legacy);
});
