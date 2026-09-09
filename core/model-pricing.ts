import {
  PROVIDER_PROTOCOLS,
  validateVertexEndpoint,
  type Connection,
  type ModelPreset,
} from './product.js';
import type { ModelPricing, PricingSnapshot, TokenRates } from './pricing-types.js';
import { ProviderContractError } from './provider-errors.js';

const CHECKED_AT = '2026-09-09';
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
export function validateModelPricing(value: unknown): ModelPricing {
  const b = object(value, ['mode', 'rates', 'flexRates']);
  if (b.mode === 'official') {
    if (Object.keys(b).length !== 1) return fail();
    return { mode: 'official' };
  }
  if (b.mode !== 'manual') return fail();
  return {
    mode: 'manual',
    rates: rates(b.rates),
    ...(Object.hasOwn(b, 'flexRates') ? { flexRates: rates(b.flexRates) } : {}),
  };
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
const tokenRates = (
  input: number,
  cacheRead: number | null,
  cacheWrite: number | null,
  output: number,
  cacheWrite1h?: number
): TokenRates => ({
  input,
  cacheRead,
  cacheWrite,
  output,
  ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
});
const scale = (value: TokenRates, factor: number): TokenRates =>
  Object.fromEntries(
    Object.entries(value).map(([key, amount]) => [key, amount === null ? null : amount * factor])
  ) as TokenRates;
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

/** Current reference rates only. The caller freezes this result with the execution snapshot. */
export function resolveModelPricing(
  model: Pick<ModelPreset, 'modelId' | 'serviceTier' | 'cacheTtl' | 'pricing'>,
  connection: Connection,
  now = new Date().toISOString()
): PricingSnapshot | undefined {
  const tier = model.serviceTier ?? 'default';
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
    if (tier === 'flex' && !config.flexRates) return undefined;
    return validatePricingSnapshot({
      ...base,
      source: 'manual',
      checkedAt: now,
      rates: tier === 'flex' ? config.flexRates : config.rates,
      ...(config.flexRates ? { standardRates: config.rates, flexRates: config.flexRates } : {}),
      notes: ['사용자가 입력한 참고 단가예요. 실제 청구액과 다를 수 있어요.'],
    });
  }
  const standard = ['auto', 'default', 'standard', 'standard_only'].includes(tier);
  const official = (
    data: Omit<PricingSnapshot, keyof typeof base | 'source' | 'checkedAt'>
  ): PricingSnapshot =>
    validatePricingSnapshot({ ...base, source: 'official', checkedAt: CHECKED_AT, ...data });
  if (
    ['openai-responses-v1', 'openai-chat-v1'].includes(connection.protocol) &&
    exactEndpoint(connection, 'api.openai.com')
  ) {
    if (
      !['auto', 'default', 'flex', 'priority', 'fast'].includes(tier) ||
      (model.cacheTtl && model.cacheTtl !== '30m')
    )
      return undefined;
    const table: Record<string, TokenRates> = {
      'gpt-6-astra': tokenRates(10, 1, 12.5, 50),
      'gpt-5.6-sol': tokenRates(4, 0.4, 5, 20),
      'gpt-5.6': tokenRates(4, 0.4, 5, 20),
      'gpt-5.6-terra': tokenRates(2, 0.2, 2.5, 12),
      'gpt-5.6-luna': tokenRates(0.2, 0.02, 0.25, 1.2),
    };
    const normal = table[model.modelId];
    if (!normal) return undefined;
    const selected = scale(
      normal,
      tier === 'flex' ? 0.5 : ['priority', 'fast'].includes(tier) ? 2 : 1
    );
    const long = scale(selected, 2);
    long.output = selected.output! * 1.5;
    return official({
      rates: selected,
      standardRates: normal,
      longContext: { aboveInputTokens: 272_000, rates: long },
      sourceUrl: 'https://developers.openai.com/api/docs/pricing',
      notes: [
        '입력 272K 초과 시 요청 전체에 장문 요금을 적용해요.',
        ...(model.modelId === 'gpt-5.6-sol' || model.modelId === 'gpt-5.6'
          ? [
              'Sol 프로모션 단가는 최소 2026-11-21까지예요. 이후에는 공식 가격을 다시 확인해 주세요.',
            ]
          : []),
        ...(tier === 'auto'
          ? ['auto는 표준 단가를 기준으로 해요. 실제 적용된 tier를 확인해야 해요.']
          : []),
      ],
    });
  }
  if (
    connection.protocol === 'anthropic-messages-v1' &&
    exactEndpoint(connection, 'api.anthropic.com')
  ) {
    if (
      !['auto', 'default', 'standard_only'].includes(tier) ||
      (model.cacheTtl && !['5m', '1h'].includes(model.cacheTtl))
    )
      return undefined;
    const value =
      model.modelId === 'claude-fable-5-1'
        ? tokenRates(10, 0.25, 12.5, 50, 20)
        : model.modelId === 'claude-opus-5'
          ? tokenRates(5, 0.5, 6.25, 25, 10)
          : undefined;
    if (!value) return undefined;
    return official({
      rates: value,
      sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
      notes: [
        '1M 문맥까지 같은 단가예요. 캐시 쓰기는 5분과 1시간을 구분해요.',
        '전역 추론 기준이며 US-only 추론과 Fast 모드의 추가 요금은 포함하지 않아요.',
      ],
    });
  }
  if (connection.protocol === 'vertex-gemini-v1') {
    try {
      validateVertexEndpoint(connection.endpoint);
    } catch {
      return undefined;
    }
    if (!['auto', 'default', 'standard', 'flex'].includes(tier)) return undefined;
    const flex = tier === 'flex',
      promo = now < '2027-01-01';
    let value: TokenRates, longContext: PricingSnapshot['longContext'];
    const notes = [
      'Google Cloud global endpoint 기준이에요. 명시적 캐시 저장시간 요금은 포함하지 않아요.',
    ];
    if (model.modelId === 'gemini-3.1-pro-preview') {
      value = flex ? tokenRates(1, null, null, 6) : tokenRates(2, 0.2, null, 12);
      longContext = {
        aboveInputTokens: 200_000,
        rates: flex ? tokenRates(2, null, null, 9) : tokenRates(4, 0.4, null, 18),
      };
      if (flex) notes.push('공식 Vertex Flex 표의 캐시 읽기 단가는 N/A예요.');
    } else if (model.modelId === 'gemini-3.5-flash-lite')
      value = scale(tokenRates(0.3, 0.03, null, 2.5), flex ? 0.5 : 1);
    else if (model.modelId === 'gemini-3.8-flash') {
      value = scale(tokenRates(1.5, 0.15, null, 7.5), (flex ? 0.5 : 1) * (promo ? 0.5 : 1));
      if (promo)
        notes.push(
          '2026-12-31까지 50% 크레딧 환급을 반영한 프로모션 단가이며 즉시 청구액과 다를 수 있어요.'
        );
    } else return undefined;
    return official({
      rates: value,
      standardRates:
        model.modelId === 'gemini-3.1-pro-preview'
          ? tokenRates(2, 0.2, null, 12)
          : flex
            ? scale(value, 2)
            : value,
      flexRates:
        model.modelId === 'gemini-3.1-pro-preview'
          ? tokenRates(1, null, null, 6)
          : flex
            ? value
            : scale(value, 0.5),
      ...(longContext
        ? { flexLongContext: { aboveInputTokens: 200_000, rates: tokenRates(2, null, null, 9) } }
        : {}),
      ...(longContext ? { longContext } : {}),
      sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing',
      notes,
    });
  }
  if (
    ['deepseek-chat-v1', 'openai-chat-v1'].includes(connection.protocol) &&
    exactEndpoint(connection, 'api.deepseek.com', ['', '/v1'])
  ) {
    if (!standard || tier === 'standard_only') return undefined;
    const value =
      model.modelId === 'deepseek-v4-flash'
        ? tokenRates(0.22, 0.007, null, 0.66)
        : model.modelId === 'deepseek-v4-pro'
          ? tokenRates(0.66, 0.022, null, 1.98)
          : undefined;
    if (!value) return undefined;
    return official({
      rates: value,
      schedule: {
        peakRates: scale(value, 2),
        weekdays: [1, 2, 3, 4, 5],
        utcHours: [
          [1, 4],
          [6, 10],
        ],
      },
      sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing/',
      notes: ['월–금 UTC 01–04시와 06–10시는 혼잡 요금, 나머지는 비혼잡 요금이에요.'],
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
      ...(selected.longContext ? { longContext: selected.longContext } : {}),
      ...(flex
        ? {
            flexRates: flex.rates,
            ...(flex.longContext ? { flexLongContext: flex.longContext } : {}),
          }
        : {}),
      notes: [
        '공급자 모델 목록의 참고 단가예요. 자동 라우팅과 공급자별 요금에 따라 달라질 수 있어요.',
      ],
    });
  }
  return undefined;
}
