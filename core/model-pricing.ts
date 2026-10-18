import { PROVIDER_PROTOCOLS, type Connection, type ModelPreset } from './product.js';
import type { ModelPricing, PricingSnapshot, TokenRates } from './pricing-types.js';
import { ProviderContractError } from './provider-errors.js';

const fail = (): never => {
  throw new ProviderContractError('INVALID_MODEL_PRICING');
};
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    return fail();
  return value as Record<string, unknown>;
}
function amount(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e6)
    return fail();
  return value;
}
function string(value: unknown, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return fail();
  return value;
}
function rates(value: unknown): TokenRates {
  const b = object(value, ['input', 'cacheRead', 'cacheWrite', 'output', 'cacheWrite1h']);
  return {
    input: amount(b.input),
    cacheRead: amount(b.cacheRead),
    cacheWrite: amount(b.cacheWrite),
    output: amount(b.output),
    ...(Object.hasOwn(b, 'cacheWrite1h') ? { cacheWrite1h: amount(b.cacheWrite1h) } : {}),
  };
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    return fail();
  return value;
}
function checkedDate(value: unknown): string {
  const result = string(value, 40);
  if (
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(result) ||
    !Number.isFinite(Date.parse(result)) ||
    new Date(result).toISOString().slice(0, 10) !== result.slice(0, 10)
  )
    return fail();
  return result;
}
function sourceUrl(value: unknown): string {
  const result = string(value, 2000);
  let url: URL;
  try {
    url = new URL(result);
  } catch {
    return fail();
  }
  if (url.protocol !== 'https:' || url.username || url.password) return fail();
  return result;
}
function contextRates(value: unknown) {
  const b = object(value, ['aboveInputTokens', 'rates']);
  return { aboveInputTokens: integer(b.aboveInputTokens, 1, 100_000_000), rates: rates(b.rates) };
}
export function validateModelPricing(value: unknown): ModelPricing {
  const b = object(value, [
    'mode',
    'rates',
    'flexRates',
    'batchRates',
    'longContext',
    'flexLongContext',
    'batchLongContext',
    'sourceUrl',
    'checkedAt',
  ]);
  if (b.mode === 'official') {
    if (Object.keys(b).length !== 1) return fail();
    return { mode: 'official' };
  }
  if (b.mode !== 'manual') return fail();
  const result: Extract<ModelPricing, { mode: 'manual' }> = {
    mode: 'manual',
    rates: rates(b.rates),
  };
  for (const key of ['flexRates', 'batchRates'] as const)
    if (Object.hasOwn(b, key)) result[key] = rates(b[key]);
  for (const key of ['longContext', 'flexLongContext', 'batchLongContext'] as const)
    if (Object.hasOwn(b, key)) result[key] = contextRates(b[key]);
  if (
    (result.flexLongContext && !result.flexRates) ||
    (result.batchLongContext && !result.batchRates)
  )
    return fail();
  if (Object.hasOwn(b, 'sourceUrl')) result.sourceUrl = sourceUrl(b.sourceUrl);
  if (Object.hasOwn(b, 'checkedAt')) result.checkedAt = checkedDate(b.checkedAt);
  return result;
}
export function validatePricingSnapshot(value: unknown): PricingSnapshot {
  const b = object(value, [
    'version',
    'protocol',
    'modelId',
    'source',
    'sourceUrl',
    'checkedAt',
    'serviceTier',
    'rates',
    'standardRates',
    'standardLongContext',
    'flexRates',
    'flexLongContext',
    'longContext',
    'schedule',
    'cacheTtl',
    'notes',
  ]);
  if (
    b.version !== 1 ||
    !PROVIDER_PROTOCOLS.includes(b.protocol as Connection['protocol']) ||
    !['official', 'manual', 'catalog'].includes(String(b.source))
  )
    return fail();
  const checkedAt = string(b.checkedAt, 40);
  if (
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(checkedAt) ||
    !Number.isFinite(Date.parse(checkedAt)) ||
    new Date(checkedAt).toISOString().slice(0, 10) !== checkedAt.slice(0, 10)
  )
    return fail();
  if (!Array.isArray(b.notes) || b.notes.length > 20) return fail();
  const result: PricingSnapshot = {
    version: 1,
    protocol: b.protocol as Connection['protocol'],
    modelId: string(b.modelId, 200),
    source: b.source as PricingSnapshot['source'],
    checkedAt,
    serviceTier: string(b.serviceTier, 100),
    rates: rates(b.rates),
    notes: b.notes.map((note) => string(note, 1000)),
  };
  if (Object.hasOwn(b, 'sourceUrl')) {
    const value = string(b.sourceUrl, 2000);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return fail();
    }
    if (url.protocol !== 'https:' || url.username || url.password) return fail();
    result.sourceUrl = value;
  }
  if (Object.hasOwn(b, 'standardLongContext'))
    result.standardLongContext = contextRates(b.standardLongContext);
  if (Object.hasOwn(b, 'standardRates')) result.standardRates = rates(b.standardRates);
  if (Object.hasOwn(b, 'flexRates')) result.flexRates = rates(b.flexRates);
  if (Object.hasOwn(b, 'cacheTtl')) result.cacheTtl = string(b.cacheTtl, 100);
  if (Object.hasOwn(b, 'longContext')) {
    const long = object(b.longContext, ['aboveInputTokens', 'rates']);
    result.longContext = {
      aboveInputTokens: integer(long.aboveInputTokens, 1, 100_000_000),
      rates: rates(long.rates),
    };
  }
  if (Object.hasOwn(b, 'flexLongContext')) {
    const long = object(b.flexLongContext, ['aboveInputTokens', 'rates']);
    result.flexLongContext = {
      aboveInputTokens: integer(long.aboveInputTokens, 1, 100_000_000),
      rates: rates(long.rates),
    };
    if (!result.flexRates) return fail();
  }
  if (Object.hasOwn(b, 'schedule')) {
    const schedule = object(b.schedule, ['peakRates', 'weekdays', 'utcHours']);
    if (
      !Array.isArray(schedule.weekdays) ||
      !schedule.weekdays.length ||
      schedule.weekdays.length > 7 ||
      !Array.isArray(schedule.utcHours) ||
      !schedule.utcHours.length ||
      schedule.utcHours.length > 24
    )
      return fail();
    const weekdays = schedule.weekdays.map((day) => integer(day, 0, 6));
    if (new Set(weekdays).size !== weekdays.length) return fail();
    const utcHours: [number, number][] = schedule.utcHours.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) return fail();
      const start = integer(pair[0], 0, 23),
        end = integer(pair[1], 1, 24);
      if (start >= end) return fail();
      return [start, end];
    });
    const ordered = [...utcHours].sort(([a], [b]) => a - b);
    if (ordered.some(([start], index) => index > 0 && start < ordered[index - 1][1])) return fail();
    result.schedule = { peakRates: rates(schedule.peakRates), weekdays, utcHours };
  }
  return result;
}
function exactEndpoint(connection: Connection, host: string, paths = ['/v1']): boolean {
  try {
    const url = new URL(connection.endpoint);
    return (
      url.origin === `https://${host}` &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      paths.includes(url.pathname.replace(/\/$/, ''))
    );
  } catch {
    return false;
  }
}

/** User rates or prices published by this connection only. The caller freezes this result with the execution snapshot. */
export function resolveModelPricing(
  model: Pick<ModelPreset, 'modelId' | 'serviceTier' | 'cacheTtl' | 'pricing' | 'executionMode'>,
  connection: Connection,
  now = new Date().toISOString()
): PricingSnapshot | undefined {
  const batch = connection.protocol === 'anthropic-messages-v1' && model.executionMode === 'batch';
  const tier = batch ? 'batch' : (model.serviceTier ?? 'default');
  const base = {
    version: 1 as const,
    protocol: connection.protocol,
    modelId: model.modelId,
    serviceTier: tier,
    ...(model.cacheTtl ? { cacheTtl: model.cacheTtl } : {}),
  };
  const config =
    model.pricing === undefined
      ? { mode: 'official' as const }
      : validateModelPricing(model.pricing);
  if (config.mode === 'manual') {
    const selected = batch ? config.batchRates : tier === 'flex' ? config.flexRates : config.rates;
    if (!selected) return undefined;
    const longContext = batch
      ? config.batchLongContext
      : tier === 'flex'
        ? config.flexLongContext
        : config.longContext;
    return validatePricingSnapshot({
      ...base,
      source: 'manual',
      checkedAt: config.checkedAt ?? now,
      ...(config.sourceUrl ? { sourceUrl: config.sourceUrl } : {}),
      rates: selected,
      ...(longContext ? { longContext } : {}),
      ...(config.longContext ? { standardLongContext: config.longContext } : {}),
      ...(!batch && config.flexRates
        ? {
            standardRates: config.rates,
            flexRates: config.flexRates,
            ...(config.flexLongContext ? { flexLongContext: config.flexLongContext } : {}),
          }
        : {}),
      notes: ['사용자가 입력한 참고 단가예요. 실제 청구액과 다를 수 있어요.'],
    });
  }

  if (
    connection.protocol === 'vercel-chat-v1' &&
    exactEndpoint(connection, 'ai-gateway.vercel.sh')
  ) {
    const entry = connection.catalog.find((item) => item.id === model.modelId);
    if (!entry?.pricing) return undefined;
    const selected = ['auto', 'default', 'standard'].includes(tier)
      ? entry.pricing
      : entry.pricing.serviceTiers && Object.hasOwn(entry.pricing.serviceTiers, tier)
        ? entry.pricing.serviceTiers[tier]
        : undefined;
    if (!selected) return undefined;
    const flex = entry.pricing.serviceTiers?.flex;
    return validatePricingSnapshot({
      ...base,
      source: 'catalog',
      sourceUrl: 'https://ai-gateway.vercel.sh/v1/models',
      checkedAt: connection.catalogUpdatedAt ?? now,
      rates: selected.rates,
      standardRates: entry.pricing.rates,
      ...(entry.pricing.longContext ? { standardLongContext: entry.pricing.longContext } : {}),
      ...(selected.longContext ? { longContext: selected.longContext } : {}),
      ...(flex
        ? {
            flexRates: flex.rates,
            ...(flex.longContext ? { flexLongContext: flex.longContext } : {}),
          }
        : {}),
      notes: [
        '프로바이더 모델 목록의 참고 단가예요. 자동 라우팅과 프로바이더별 요금에 따라 달라질 수 있어요.',
      ],
    });
  }
  return undefined;
}
