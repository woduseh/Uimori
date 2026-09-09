import { expect, test } from 'vitest';
import { estimateCost } from '../core/pricing-estimate.js';
import type { PricingSnapshot, TokenRates } from '../core/pricing-types.js';

const rates: TokenRates = { input: 2, cacheRead: 0.5, cacheWrite: 3, output: 8 };
const snapshot = (
  protocol: PricingSnapshot['protocol'] = 'openai-responses-v1'
): PricingSnapshot => ({
  version: 1,
  protocol,
  modelId: 'synthetic-model',
  source: 'manual',
  checkedAt: '2026-09-09',
  serviceTier: 'standard',
  rates: { ...rates },
  notes: [],
});
const started = '2026-09-09T12:00:00Z';
const responses = {
  inputTokens: 1000,
  outputTokens: 100,
  raw: { input_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 } },
};
const value = (result: ReturnType<typeof estimateCost>, kind: string) =>
  result.lines.find((line) => line.kind === kind);

test('Gateway reported cache writes are separate from input and reads', () => {
  const priced = estimateCost(
    snapshot('vercel-chat-v1'),
    {
      inputTokens: 1000,
      outputTokens: 100,
      raw: { prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 } },
    },
    started
  );
  expect(priced.usd).toBeCloseTo(0.0026);
  expect(value(priced, 'input')?.tokens).toBe(700);
  expect(value(priced, 'cacheWrite')?.tokens).toBe(100);
});

test('Vertex reported traffic type prevents applying a different requested tier price', () => {
  expect(
    estimateCost(
      snapshot('vertex-gemini-v1'),
      {
        inputTokens: 1000,
        outputTokens: 100,
        raw: { cachedContentTokenCount: 0, trafficType: 'ON_DEMAND_FLEX' },
      },
      started
    )
  ).toMatchObject({ status: 'unavailable', usd: null, notes: ['SERVICE_TIER_MISMATCH'] });
});

test('Responses disjoint input/cache read/cache write and normalized reasoning output', () => {
  const result = estimateCost(
    snapshot(),
    { ...responses, raw: { ...responses.raw, output_tokens_details: { reasoning_tokens: 80 } } },
    started
  );
  expect(result.status).toBe('estimated');
  expect(result.usd).toBeCloseTo(0.0026);
  expect(value(result, 'input')?.tokens).toBe(700);
  expect(value(result, 'output')?.tokens).toBe(100);
});

test.each(['openai-chat-v1', 'vercel-chat-v1'] as const)(
  '%s uses included cache read without inventing a write charge',
  (protocol) => {
    const result = estimateCost(
      { ...snapshot(protocol), rates: { ...rates, cacheWrite: null } },
      {
        inputTokens: 1000,
        outputTokens: 100,
        raw: { prompt_tokens_details: { cached_tokens: 200 } },
      },
      started
    );
    expect(result.usd).toBeCloseTo(0.0025);
    expect(result.lines.map((line) => line.kind)).toEqual(['input', 'cacheRead', 'output']);
  }
);

test('Vertex output is already candidates plus thoughts; cached input is included', () => {
  const result = estimateCost(
    snapshot('vertex-gemini-v1'),
    {
      inputTokens: 1000,
      outputTokens: 100,
      raw: { cachedContentTokenCount: 200, candidatesTokenCount: 60, thoughtsTokenCount: 40 },
    },
    started
  );
  expect(result.usd).toBeCloseTo(0.0025);
  expect(value(result, 'output')?.tokens).toBe(100);
});

test('DeepSeek cache hit tokens are a subset of normalized input', () => {
  const result = estimateCost(
    snapshot('deepseek-chat-v1'),
    {
      inputTokens: 1000,
      outputTokens: 100,
      raw: { prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 800 },
    },
    started
  );
  expect(result.usd).toBeCloseTo(0.0025);
});

const anthropic = {
  inputTokens: 1000,
  outputTokens: 100,
  raw: {
    input_tokens: 700,
    cache_read_input_tokens: 200,
    cache_creation_input_tokens: 100,
    cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 40 },
  },
};
test('Anthropic raw input excludes caches but adapter total includes both, including TTL split', () => {
  const pricing = snapshot('anthropic-messages-v1');
  pricing.rates.cacheWrite1h = 4;
  const result = estimateCost(pricing, anthropic, started);
  expect(result.usd).toBeCloseTo(0.00264);
  expect(value(result, 'input')?.tokens).toBe(700);
  expect(value(result, 'cacheWrite')?.tokens).toBe(60);
  expect(value(result, 'cacheWrite1h')?.tokens).toBe(40);
});

test('missing Anthropic cache split stays unknown, never assumes default TTL', () => {
  const pricing = snapshot('anthropic-messages-v1');
  pricing.rates.cacheWrite1h = 4;
  const result = estimateCost(
    pricing,
    { ...anthropic, raw: { ...anthropic.raw, cache_creation: undefined } },
    started
  );
  expect(result.status).toBe('partial');
  expect(result.usd).toBeNull();
  expect(value(result, 'cacheWrite')?.tokens).toBeNull();
  expect(value(result, 'cacheWrite1h')?.tokens).toBeNull();
});

test('explicit total write zero establishes both zero TTL buckets', () => {
  const pricing = snapshot('anthropic-messages-v1');
  pricing.rates.cacheWrite1h = 4;
  const result = estimateCost(
    pricing,
    {
      inputTokens: 700,
      outputTokens: 100,
      raw: { input_tokens: 700, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    started
  );
  expect(result.status).toBe('estimated');
  expect(value(result, 'cacheWrite1h')?.tokens).toBe(0);
});

test.each([null, undefined, -1, '200', NaN])(
  'missing or malformed cache count %s never becomes zero',
  (cached) => {
    const result = estimateCost(
      snapshot(),
      {
        ...responses,
        raw: { input_tokens_details: { cached_tokens: cached, cache_write_tokens: 100 } },
      },
      started
    );
    expect(result.status).toBe('partial');
    expect(result.usd).toBeNull();
    expect(result.subtotalUsd).toBeCloseTo(0.0011);
    expect(value(result, 'input')?.tokens).toBeNull();
  }
);

test('missing usage has no estimate; partial output absence retains only known subtotal', () => {
  expect(
    estimateCost(snapshot(), { inputTokens: null, outputTokens: null, raw: null }, started)
  ).toMatchObject({ status: 'unavailable', usd: null, subtotalUsd: 0 });
  expect(estimateCost(snapshot(), { ...responses, outputTokens: null }, started)).toMatchObject({
    status: 'partial',
    usd: null,
  });
});

test('unknown rate remains unknown; only an explicit zero price is free', () => {
  const pricing = snapshot();
  pricing.rates.output = null;
  expect(estimateCost(pricing, responses, started)).toMatchObject({ status: 'partial', usd: null });
  pricing.rates = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  expect(estimateCost(pricing, responses, started)).toMatchObject({ status: 'estimated', usd: 0 });
  pricing.rates.output = -5;
  expect(value(estimateCost(pricing, responses, started), 'output')?.rate).toBeNull();
});

test('inconsistent caches and normalized Anthropic totals cannot produce negative input costs', () => {
  expect(estimateCost(snapshot(), { ...responses, inputTokens: 100 }, started)).toMatchObject({
    status: 'partial',
    usd: null,
    notes: ['INCONSISTENT_INPUT_USAGE', 'USAGE_OR_RATE_UNKNOWN'],
  });
  expect(
    estimateCost(snapshot('anthropic-messages-v1'), { ...anthropic, inputTokens: 800 }, started)
      .notes
  ).toContain('INCONSISTENT_INPUT_USAGE');
});

test.each([999, 1000, 1001])(
  'long-context boundary uses total Anthropic input including caches: %s',
  (total) => {
    const pricing = snapshot('anthropic-messages-v1');
    pricing.longContext = { aboveInputTokens: 1000, rates: { ...rates, input: 4 } };
    const result = estimateCost(
      pricing,
      {
        inputTokens: total,
        outputTokens: 100,
        raw: {
          input_tokens: total - 300,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 100,
        },
      },
      started
    );
    expect(value(result, 'input')?.rate).toBe(total > 1000 ? 4 : 2);
  }
);

test('unknown total cannot select a long-context price tier', () => {
  const pricing = snapshot();
  pricing.longContext = { aboveInputTokens: 1000, rates };
  expect(estimateCost(pricing, { ...responses, inputTokens: null }, started)).toMatchObject({
    status: 'unavailable',
    usd: null,
    notes: ['CONTEXT_PRICE_TIER_UNKNOWN'],
  });
});

test.each([
  ['2026-09-09T08:59:59Z', 2],
  ['2026-09-09T09:00:00Z', 4],
  ['2026-09-09T16:59:59Z', 4],
  ['2026-09-09T17:00:00Z', 2],
  ['2026-09-12T10:00:00Z', 2],
  ['2026-09-09T18:00:00+09:00', 4],
] as const)('schedule uses UTC weekday and half-open hours: %s', (date, rate) => {
  const pricing = snapshot();
  pricing.schedule = {
    peakRates: { ...rates, input: 4 },
    weekdays: [1, 2, 3, 4, 5],
    utcHours: [[9, 17]],
  };
  expect(value(estimateCost(pricing, responses, date), 'input')?.rate).toBe(rate);
});

test('invalid scheduled start date is unavailable', () => {
  const pricing = snapshot();
  pricing.schedule = { peakRates: rates, weekdays: [1], utcHours: [[9, 17]] };
  expect(estimateCost(pricing, responses, 'invalid').status).toBe('unavailable');
});

test.each(['default', 'auto', 'standard', 'ON_DEMAND'])(
  'standard tier alias %s is compatible',
  (actual) => {
    expect(estimateCost(snapshot(), responses, started, actual).status).toBe('estimated');
  }
);

test('Flex price requires matching actual tier, never silently switches to standard rates', () => {
  const pricing = snapshot();
  pricing.serviceTier = 'flex';
  pricing.standardRates = rates;
  expect(estimateCost(pricing, responses, started, 'ON_DEMAND_FLEX').status).toBe('estimated');
  expect(estimateCost(pricing, responses, started, 'standard')).toMatchObject({
    status: 'unavailable',
    usd: null,
    notes: ['SERVICE_TIER_MISMATCH'],
  });
});

test('snapshot estimate is deterministic and does not mutate frozen pricing or usage', () => {
  const pricing = snapshot();
  Object.freeze(pricing.rates);
  Object.freeze(pricing);
  Object.freeze(responses.raw.input_tokens_details);
  Object.freeze(responses.raw);
  Object.freeze(responses);
  expect(estimateCost(pricing, responses, started)).toEqual(
    estimateCost(structuredClone(pricing), structuredClone(responses), started)
  );
  expect(estimateCost(undefined, responses, started).status).toBe('unavailable');
  expect(estimateCost(snapshot('fixture-sse-v1'), responses, started).status).toBe('unavailable');
});
