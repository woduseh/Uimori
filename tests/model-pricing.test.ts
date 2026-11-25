import { expect, test } from 'vitest';
import type { Connection, ModelPreset, ProviderProtocol } from '../core/product.js';
import {
  resolveModelPricing,
  validateJudgmentPricing,
  validateModelPricing,
  validatePricingSnapshot,
} from '../core/model-pricing.js';
import { estimateCost } from '../core/pricing-estimate.js';
import {
  judgmentPriceFor,
  judgmentPriceKey,
  judgmentPriceTarget,
  judgmentPricingSnapshot,
} from '../core/judgment-settings.js';
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
  for (const invalid of [-1, NaN, '4'])
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
    { checkedAt: '2026-02-30' },
    { sourceUrl: 'http://unsafe.example' },
    { longContext: { aboveInputTokens: 0, rates: r } },
    { rates: { ...r, cacheRead: Infinity } },
  ])
    expect(() => validatePricingSnapshot({ ...valid, ...extra })).toThrow();
});

test('built-in manufacturer tables are retired even for exact official endpoints and known IDs', () => {
  for (const [protocol, endpoint, modelId] of [
    ['openai-responses-v1', 'https://api.openai.com/v1', 'gpt-5.6-sol'],
    ['anthropic-messages-v1', 'https://api.anthropic.com/v1', 'claude-opus-5-5'],
    ['vertex-gemini-v1', vertex.endpoint, 'gemini-4-hydrogen'],
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
    notes: ['historical'],
  };
  expect(validatePricingSnapshot(legacy)).toEqual(legacy);
});

const judgmentRates = (
  input: number | null,
  output: number | null,
  cacheRead: number | null = null
) => ({
  mode: 'manual' as const,
  rates: { input, output, cacheRead, cacheWrite: null },
});
const jevTarget = { provider: 'typesafe' as const, modelId: 'jev-latest' };

test('judgment calls are priced from the reported input and output tokens with explicit zero output as known', () => {
  const jev = judgmentPricingSnapshot(jevTarget, judgmentRates(0.042, 0), at)!;
  expect(validatePricingSnapshot(jev)).toEqual(jev);
  expect(jev).toMatchObject({ protocol: 'typesafe-systemone-v1', modelId: 'jev-latest' });
  const usage = { inputTokens: 2_000_000, outputTokens: 0, raw: { input_tokens: 2_000_000 } };
  expect(estimateCost(jev, usage)).toMatchObject({ status: 'estimated', usd: 0.084 });
  expect(estimateCost(jev, { ...usage, outputTokens: 12 })).toMatchObject({
    status: 'estimated',
    usd: 0.084,
  });
  const unknownOutput = judgmentPricingSnapshot(jevTarget, judgmentRates(0.042, null), at)!;
  expect(estimateCost(unknownOutput, { ...usage, outputTokens: 12 })).toMatchObject({
    status: 'partial',
    usd: null,
    subtotalUsd: 0.084,
  });
  expect(estimateCost(undefined, usage)).toMatchObject({ status: 'unavailable', usd: null });
  expect(estimateCost(jev, { ...usage, inputTokens: null })).toMatchObject({
    status: 'partial',
    usd: null,
    subtotalUsd: 0,
  });
  expect(judgmentPricingSnapshot(jevTarget, undefined, at)).toBeUndefined();
});

test('OpenAI Decisions cached input is priced separately only when the response reports it', () => {
  const target = { provider: 'openai' as const, modelId: 'gpt-6-luna' };
  const priced = judgmentPricingSnapshot(target, judgmentRates(1, 0, 0.1), at)!;
  const usage = (raw: unknown) => ({ inputTokens: 1_000_000, outputTokens: 0, raw });
  expect(
    estimateCost(priced, usage({ input_tokens_details: { cached_tokens: 500_000 } }))
  ).toMatchObject({ status: 'estimated', usd: 0.55 });
  expect(estimateCost(priced, usage({ input_tokens: 1 }))).toMatchObject({
    status: 'estimated',
    usd: 1,
  });
  const noCacheRate = judgmentPricingSnapshot(target, judgmentRates(1, 0), at)!;
  expect(
    estimateCost(noCacheRate, usage({ input_tokens_details: { cached_tokens: 500_000 } }))
  ).toMatchObject({ status: 'partial', usd: null, subtotalUsd: 0.5 });
});

test('judgment prices are keyed by provider and model, and by connection only for compatible formats', () => {
  const openai = { provider: 'openai', modelId: 'gpt-6-luna', images: false } as const;
  expect(judgmentPriceTarget({ provider: 'typesafe' })).toEqual(jevTarget);
  expect(judgmentPriceTarget({ ...openai, connectionId: 'a' })).toEqual(
    judgmentPriceTarget({ ...openai, connectionId: 'b' })
  );
  const gateway = (connectionId: string) =>
    judgmentPriceTarget({
      provider: 'openai-compatible',
      modelId: 'openai/gpt-6-luna-decisions',
      connectionId,
      images: false,
    });
  expect(judgmentPriceKey(gateway('a'))).not.toBe(judgmentPriceKey(gateway('b')));
  const entries = [
    { ...gateway('a'), pricing: judgmentRates(1, 0) },
    { ...jevTarget, pricing: judgmentRates(0.042, 0) },
  ];
  expect(judgmentPriceFor(entries, gateway('a'))).toEqual(judgmentRates(1, 0));
  expect(judgmentPriceFor(entries, gateway('b'))).toBeUndefined();
  expect(judgmentPriceFor(entries, jevTarget)).toEqual(judgmentRates(0.042, 0));
});

test('judgment price validation keeps only the rates the provider reports usage for', () => {
  expect(validateJudgmentPricing(judgmentRates(0.042, 0), 'typesafe')).toEqual(
    judgmentRates(0.042, 0)
  );
  for (const [value, provider] of [
    [judgmentRates(0.042, 0, 0.01), 'typesafe'],
    [judgmentRates(0.042, 0, 0.01), 'gemini'],
    [judgmentRates(null, null), 'typesafe'],
    [{ mode: 'official' }, 'typesafe'],
    [{ ...judgmentRates(1, 0), flexRates: r }, 'openai'],
    [{ ...judgmentRates(1, 0), longContext: { aboveInputTokens: 10, rates: r } }, 'typesafe'],
    [{ ...judgmentRates(1, 0), rates: { ...judgmentRates(1, 0).rates, cacheWrite: 1 } }, 'openai'],
  ] as const)
    expect(() => validateJudgmentPricing(value, provider)).toThrow();
  expect(validateJudgmentPricing(judgmentRates(1, 0, 0.1), 'openai-compatible').rates).toEqual({
    input: 1,
    output: 0,
    cacheRead: 0.1,
    cacheWrite: null,
  });
});
