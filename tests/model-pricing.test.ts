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

test('Vertex snapshots freeze Flex alternatives before a host tier override, including Pro long context', () => {
  const pro = resolve('gemini-3.1-pro-preview', vertex)!;
  expect(pro).toMatchObject({
    standardRates: { input: 2, cacheRead: 0.2, output: 12 },
    flexRates: { input: 1, cacheRead: null, output: 6 },
    flexLongContext: { aboveInputTokens: 200000, rates: { input: 2, cacheRead: null, output: 9 } },
  });
  expect(validatePricingSnapshot(pro)).toEqual(pro);
  const flash = resolve('gemini-3.8-flash', vertex)!;
  expect(flash.flexRates?.output).toBe(1.875);
  expect(flash.standardRates?.output).toBe(3.75);
  expect(flash.flexLongContext).toBeUndefined();
  expect(() =>
    validatePricingSnapshot({ ...pro, flexRates: { ...r, cacheRead: Infinity } })
  ).toThrow();
  expect(() =>
    validatePricingSnapshot({ ...pro, flexLongContext: { aboveInputTokens: -1, rates: r } })
  ).toThrow();
});

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

test('OpenAI exact model IDs, alias, tiers and full-request long context rates are distinct', () => {
  expect(resolve('gpt-5.6-sol')?.rates).toEqual(r);
  expect(resolve('gpt-5.6')?.rates).toEqual(r);
  expect(resolve('gpt-6-astra')?.rates).toEqual({
    input: 10,
    cacheRead: 1,
    cacheWrite: 12.5,
    output: 50,
  });
  expect(resolve('gpt-5.6-terra')?.rates).toEqual({
    input: 2,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    output: 12,
  });
  expect(resolve('gpt-5.6-luna')?.rates).toEqual({
    input: 0.2,
    cacheRead: 0.02,
    cacheWrite: 0.25,
    output: 1.2,
  });
  const flex = resolve('gpt-5.6-sol', openai, { serviceTier: 'flex' });
  expect(flex).toMatchObject({
    rates: { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
    standardRates: r,
    longContext: {
      aboveInputTokens: 272000,
      rates: { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 15 },
    },
  });
  expect(resolve('gpt-5.6-sol', openai, { serviceTier: 'priority' })?.rates.output).toBe(40);
  expect(resolve('gpt-5.6-sol', openai, { serviceTier: 'ultrafast' })).toBeUndefined();
  expect(resolve('gpt-5.6-sol', openai, { cacheTtl: '1h' })).toBeUndefined();
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

test('Vertex promotion expires without carrying the credit note into 2027 and Pro Flex cache remains unknown', () => {
  expect(resolve('gemini-3.8-flash', vertex)?.rates).toEqual({
    input: 0.75,
    cacheRead: 0.075,
    cacheWrite: null,
    output: 3.75,
  });
  expect(resolve('gemini-3.8-flash', vertex, { serviceTier: 'flex' })?.rates.output).toBe(1.875);
  const after = resolve('gemini-3.8-flash', vertex, {}, '2027-01-01T00:00:00Z');
  expect(after?.rates.output).toBe(7.5);
  expect(after?.notes.some((note) => note.includes('환급'))).toBe(false);
  expect(resolve('gemini-3.5-flash-lite', vertex, { serviceTier: 'flex' })?.rates).toEqual({
    input: 0.15,
    cacheRead: 0.015,
    cacheWrite: null,
    output: 1.25,
  });
  expect(resolve('gemini-3.1-pro-preview', vertex, { serviceTier: 'flex' })).toMatchObject({
    rates: { input: 1, cacheRead: null, output: 6 },
    longContext: { aboveInputTokens: 200000, rates: { input: 2, cacheRead: null, output: 9 } },
  });
});

test('Claude has model-specific cache reads and both write TTLs, without a long context premium', () => {
  const c = connection('anthropic-messages-v1', 'https://api.anthropic.com/v1');
  expect(resolve('claude-fable-5-1', c, { cacheTtl: '1h' })).toMatchObject({
    rates: { input: 10, cacheRead: 0.25, cacheWrite: 12.5, cacheWrite1h: 20, output: 50 },
    cacheTtl: '1h',
  });
  const opus = resolve('claude-opus-5', c);
  expect(opus?.rates).toEqual({
    input: 5,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    cacheWrite1h: 10,
    output: 25,
  });
  expect(opus?.longContext).toBeUndefined();
  expect(resolve('claude-opus-5', c, { serviceTier: 'flex' })).toBeUndefined();
});

test('DeepSeek freezes both weekday time bands instead of choosing a rate at settings-save time', () => {
  const c = connection('deepseek-chat-v1', 'https://api.deepseek.com/v1');
  expect(resolve('deepseek-v4-pro', c)).toMatchObject({
    rates: { input: 0.66, cacheRead: 0.022, cacheWrite: null, output: 1.98 },
    schedule: {
      peakRates: { input: 1.32, cacheRead: 0.044, output: 3.96 },
      weekdays: [1, 2, 3, 4, 5],
      utcHours: [
        [1, 4],
        [6, 10],
      ],
    },
  });
  expect(resolve('deepseek-v4-flash', c)?.rates.input).toBe(0.22);
  expect(resolve('deepseek-v4-flash', c, { serviceTier: 'flex' })).toBeUndefined();
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
  const valid = resolve('gpt-5.6-sol')!;
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
