import { providerCacheUsage } from './provider-cache-usage.js';
import type { CostEstimate, PricingLine, PricingSnapshot, TokenRates } from './pricing-types.js';

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const add = (...values: (number | null)[]): number | null => {
  if (values.some((value) => value === null)) return null;
  return count(values.reduce<number>((sum, value) => sum + value!, 0));
};
const tier = (value: string) => {
  const normalized = value.toLowerCase();
  if (['standard', 'auto', 'default', 'on_demand'].includes(normalized)) return 'standard';
  return normalized === 'on_demand_flex' ? 'flex' : normalized;
};
const unavailable = (note: string): CostEstimate => ({
  status: 'unavailable',
  usd: null,
  subtotalUsd: 0,
  lines: [],
  notes: [note],
});

/** Uses frozen rates and reported counts only. It never represents a provider invoice. */
export function estimateCost(
  pricing: PricingSnapshot | undefined,
  usage: { inputTokens: number | null; outputTokens: number | null; raw: unknown },
  startedAt: string,
  actualServiceTier?: string
): CostEstimate {
  if (!pricing) return unavailable('PRICING_UNAVAILABLE');
  if (pricing.version !== 1) return unavailable('PRICING_VERSION_UNSUPPORTED');
  const supported = [
    'openai-responses-v1',
    'openai-chat-v1',
    'vercel-chat-v1',
    'deepseek-chat-v1',
    'vertex-gemini-v1',
    'anthropic-messages-v1',
  ];
  if (!supported.includes(pricing.protocol)) return unavailable('PRICING_PROTOCOL_UNSUPPORTED');
  const raw = record(usage.raw);
  const traffic = typeof raw.trafficType === 'string' ? raw.trafficType : undefined;
  const reportedTier =
    actualServiceTier ??
    (typeof raw.service_tier === 'string'
      ? raw.service_tier
      : pricing.protocol === 'vertex-gemini-v1' && traffic
        ? ((
            {
              ON_DEMAND: 'standard',
              ON_DEMAND_FLEX: 'flex',
              ON_DEMAND_PRIORITY: 'priority',
            } as Record<string, string>
          )[traffic] ?? 'unknown')
        : undefined);
  if (reportedTier !== undefined && tier(reportedTier) !== tier(pricing.serviceTier))
    return unavailable('SERVICE_TIER_MISMATCH');
  const notes: string[] = [];
  const cache = providerCacheUsage(pricing.protocol, raw)!;
  let totalInput = count(usage.inputTokens);
  let baseInput: number | null = totalInput;
  let read = cache.readTokens;
  let write = cache.writeTokens;
  let write1h: number | null | undefined;
  const anthropic = pricing.protocol === 'anthropic-messages-v1';
  const responses = pricing.protocol === 'openai-responses-v1';
  const chatWrites =
    (pricing.protocol === 'openai-chat-v1' || pricing.protocol === 'vercel-chat-v1') &&
    (pricing.rates.cacheWrite !== null ||
      pricing.longContext?.rates.cacheWrite != null ||
      write !== null);
  if (anthropic) {
    baseInput = count(raw.input_tokens);
    const calculatedTotal = add(baseInput, read, write);
    if (calculatedTotal !== null && totalInput !== null && calculatedTotal !== totalInput) {
      notes.push('INCONSISTENT_INPUT_USAGE');
      baseInput = read = write = totalInput = null;
    } else {
      totalInput = calculatedTotal ?? totalInput;
    }
  } else {
    const cached = responses || chatWrites ? add(read, write) : read;
    if (totalInput !== null && cached !== null && cached <= totalInput) {
      baseInput = totalInput - cached;
    } else {
      baseInput = null;
      if (totalInput !== null && cached !== null && cached > totalInput) {
        notes.push('INCONSISTENT_INPUT_USAGE');
        read = write = totalInput = null;
      }
    }
  }

  let rates: TokenRates = pricing.rates;
  if (pricing.schedule) {
    const started = new Date(startedAt);
    if (!Number.isFinite(started.getTime())) return unavailable('PRICING_START_TIME_INVALID');
    const { weekdays, utcHours, peakRates } = pricing.schedule;
    if (
      !weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) ||
      !utcHours.every(
        ([start, end]) =>
          Number.isInteger(start) &&
          Number.isInteger(end) &&
          start >= 0 &&
          start < 24 &&
          end > 0 &&
          end <= 24 &&
          start !== end
      )
    )
      return unavailable('PRICING_SCHEDULE_INVALID');
    const hour = started.getUTCHours();
    if (
      weekdays.includes(started.getUTCDay()) &&
      utcHours.some(([start, end]) =>
        start < end ? hour >= start && hour < end : hour >= start || hour < end
      )
    ) {
      rates = peakRates;
      notes.push('PEAK_RATES_APPLIED');
    }
  }
  if (pricing.longContext) {
    if (count(pricing.longContext.aboveInputTokens) === null)
      return unavailable('PRICING_THRESHOLD_INVALID');
    if (totalInput === null) return unavailable('CONTEXT_PRICE_TIER_UNKNOWN');
    if (totalInput > pricing.longContext.aboveInputTokens) {
      rates = pricing.longContext.rates;
      notes.push('LONG_CONTEXT_RATES_APPLIED');
    }
  }
  if (
    anthropic &&
    (rates.cacheWrite1h !== undefined ||
      (cache.write1hTokens !== null && cache.write1hTokens !== undefined))
  ) {
    const reported5m = cache.write5mTokens ?? null;
    const reported1h = cache.write1hTokens ?? null;
    const splitTotal = add(reported5m, reported1h);
    if (
      write === 0 &&
      (reported5m === null || reported5m === 0) &&
      (reported1h === null || reported1h === 0)
    ) {
      write1h = 0;
    } else if (write !== null && splitTotal !== null && write === splitTotal) {
      write = reported5m;
      write1h = reported1h;
    } else {
      write = write1h = null;
      notes.push('CACHE_WRITE_SPLIT_UNKNOWN');
    }
  }
  const lines: PricingLine[] = [];
  const line = (
    kind: PricingLine['kind'],
    tokens: number | null,
    value: number | null | undefined
  ) => {
    const rate = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const cost = tokens === null || rate === null ? null : (tokens / 1_000_000) * rate;
    lines.push({ kind, tokens, rate, usd: cost !== null && Number.isFinite(cost) ? cost : null });
  };
  line('input', baseInput, rates.input);
  line('cacheRead', read, rates.cacheRead);
  if (responses || anthropic || chatWrites) line('cacheWrite', write, rates.cacheWrite);
  if (write1h !== undefined) line('cacheWrite1h', write1h, rates.cacheWrite1h);
  // Normalized output already includes billable thinking/reasoning where the adapter supports it.
  line('output', count(usage.outputTokens), rates.output);
  const known = lines.filter((item) => item.usd !== null);
  const subtotalUsd = known.reduce((sum, item) => sum + item.usd!, 0);
  if (!Number.isFinite(subtotalUsd)) return unavailable('ESTIMATE_OVERFLOW');
  const complete = known.length === lines.length;
  if (!complete) notes.push('USAGE_OR_RATE_UNKNOWN');
  return {
    status: complete ? 'estimated' : known.length ? 'partial' : 'unavailable',
    usd: complete ? subtotalUsd : null,
    subtotalUsd,
    lines,
    notes,
  };
}
