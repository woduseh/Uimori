import type { Connection, ProviderProtocol } from './product.js';
import { PROTOCOL_OPTION_VALUES } from './model-capabilities.js';
import type { TokenRates } from './pricing-types.js';

type CatalogEntry = Connection['catalog'][number];
type Metadata = Pick<CatalogEntry, 'capabilities' | 'limits' | 'options' | 'pricing'>;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const supported = (value: unknown): boolean | null =>
  typeof object(value)?.supported === 'boolean' ? (object(value)!.supported as boolean) : null;
const limit = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 100_000_000
    ? value
    : undefined;
const values = (raw: unknown, vocabulary: readonly string[]): string[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const found = raw.filter(
    (item): item is string => typeof item === 'string' && vocabulary.includes(item)
  );
  return found.length ? [...new Set(found)] : undefined;
};

const pricingFields = {
  input: 'input',
  cacheRead: 'input_cache_read',
  cacheWrite: 'input_cache_write',
  output: 'output',
  cacheWrite1h: 'input_cache_write_1h',
} as const;
type CatalogPrice = NonNullable<CatalogEntry['pricing']>;
function tokenPrice(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' &&
    (typeof value !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))
  )
    throw new Error('Invalid token price');
  // Shift the decimal exponent before conversion to avoid artifacts such as 0.19999999999999998.
  const [mantissa, exponent = '0'] = String(value).split(/[eE]/);
  const parsed = Number(`${mantissa}e${Number(exponent) + 6}`);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000)
    throw new Error('Invalid token price');
  return parsed;
}
function catalogRates(raw: Record<string, unknown>): TokenRates {
  if (!Object.hasOwn(raw, 'input') || !Object.hasOwn(raw, 'output'))
    throw new Error('Missing token price');
  return {
    input: tokenPrice(raw.input),
    cacheRead: tokenPrice(raw.input_cache_read),
    cacheWrite: tokenPrice(raw.input_cache_write),
    output: tokenPrice(raw.output),
    ...(Object.hasOwn(raw, 'input_cache_write_1h')
      ? { cacheWrite1h: tokenPrice(raw.input_cache_write_1h) }
      : {}),
  };
}
function catalogVariant(raw: Record<string, unknown>): Pick<CatalogPrice, 'rates' | 'longContext'> {
  const rates = catalogRates(raw);
  let aboveInputTokens: number | undefined;
  const longRates = { ...rates };
  for (const [bucket, field] of Object.entries(pricingFields) as [keyof TokenRates, string][]) {
    const tiers = raw[`${field}_tiers`];
    if (tiers === undefined) continue;
    if (!Array.isArray(tiers) || tiers.length !== 2) throw new Error('Unsupported price tiers');
    const first = object(tiers[0]),
      second = object(tiers[1]);
    const threshold = limit(first?.max);
    if (
      !first ||
      !second ||
      first.min !== 0 ||
      !threshold ||
      (second.min !== threshold && second.min !== threshold + 1) ||
      second.max !== undefined ||
      first.cost === undefined ||
      second.cost === undefined ||
      tokenPrice(first.cost) !== rates[bucket]
    )
      throw new Error('Unsupported price tiers');
    if (aboveInputTokens !== undefined && aboveInputTokens !== threshold)
      throw new Error('Conflicting price thresholds');
    aboveInputTokens = threshold;
    longRates[bucket] = tokenPrice(second.cost);
  }
  if (raw.long_context !== undefined) {
    if (aboveInputTokens !== undefined) throw new Error('Mixed price tiers');
    const long = object(raw.long_context);
    aboveInputTokens = limit(long?.threshold);
    if (!long || !aboveInputTokens) throw new Error('Invalid price threshold');
    return { rates, longContext: { aboveInputTokens, rates: catalogRates(long) } };
  }
  return {
    rates,
    ...(aboveInputTokens !== undefined
      ? { longContext: { aboveInputTokens, rates: longRates } }
      : {}),
  };
}
/** Public Gateway model metadata: token prices become USD per million, without guessing discounts. */
export function catalogPricing(rawPricing: unknown): CatalogEntry['pricing'] | undefined {
  const raw = object(rawPricing);
  if (!raw) return undefined;
  try {
    const base = catalogVariant(raw);
    if (raw.service_tiers === undefined) return base;
    const rawTiers = object(raw.service_tiers);
    if (!rawTiers || Object.keys(rawTiers).length > 20) return undefined;
    const serviceTiers: NonNullable<CatalogPrice['serviceTiers']> = {};
    for (const [tier, value] of Object.entries(rawTiers)) {
      if (
        !/^[a-z][a-z0-9_-]{0,39}$/.test(tier) ||
        ['constructor', 'prototype', '__proto__'].includes(tier)
      )
        return undefined;
      const variant = object(value);
      if (!variant) return undefined;
      serviceTiers[tier] = catalogVariant(variant);
    }
    return { ...base, serviceTiers };
  } catch {
    return undefined;
  }
}

/**
 * Metadata a provider's list API publishes about one model. Only limits and option values in
 * this protocol's vocabulary are kept; the rest of the entry stays with the provider.
 */
export function catalogEntryMetadata(
  protocol: ProviderProtocol,
  raw: Record<string, unknown>
): Metadata {
  const none: Metadata = { capabilities: { tools: null, structuredOutput: null } };
  if (protocol === 'anthropic-messages-v1') {
    const capabilities = object(raw.capabilities);
    const effort = object(capabilities?.effort);
    const thinking =
      supported(effort) === true
        ? PROTOCOL_OPTION_VALUES.outputEffort.filter((level) => supported(effort?.[level]) === true)
        : [];
    const thinkingModes =
      supported(object(object(capabilities?.thinking)?.types)?.adaptive) === true
        ? ['adaptive']
        : [];
    const limits = {
      ...(limit(raw.max_tokens) ? { maxOutputTokens: limit(raw.max_tokens) } : {}),
      ...(limit(raw.max_input_tokens) ? { inputTokenLimit: limit(raw.max_input_tokens) } : {}),
    };
    return {
      capabilities: { tools: null, structuredOutput: supported(capabilities?.structured_outputs) },
      ...(Object.keys(limits).length ? { limits } : {}),
      ...(thinking.length || thinkingModes.length
        ? {
            options: {
              ...(thinking.length ? { thinking } : {}),
              ...(thinkingModes.length ? { thinkingModes } : {}),
            },
          }
        : {}),
    };
  }
  if (protocol === 'vercel-chat-v1') {
    const pricing = catalogPricing(raw.pricing);
    const tags = Array.isArray(raw.tags) ? raw.tags : [];
    const effort = Array.isArray(raw.reasoning_options)
      ? raw.reasoning_options.map(object).find((entry) => entry?.type === 'effort')
      : undefined;
    const thinking = values(effort?.values, PROTOCOL_OPTION_VALUES.reasoningEffort);
    const limits = {
      ...(limit(raw.max_tokens) ? { maxOutputTokens: limit(raw.max_tokens) } : {}),
      ...(limit(raw.context_window) ? { inputTokenLimit: limit(raw.context_window) } : {}),
    };
    return {
      capabilities: { tools: tags.includes('tool-use') ? true : null, structuredOutput: null },
      ...(Object.keys(limits).length ? { limits } : {}),
      ...(thinking ? { options: { thinking } } : {}),
      ...(pricing ? { pricing } : {}),
    };
  }
  return none;
}

/**
 * One Gemini Developer API `models.list` entry as a catalog row. Only Gemini generation models
 * are kept; the `models/` prefix is dropped so the ID matches Agent Platform's model ID.
 */
export function geminiListEntry(raw: Record<string, unknown>): CatalogEntry | undefined {
  const name = typeof raw.name === 'string' ? raw.name : '';
  const methods = Array.isArray(raw.supportedGenerationMethods)
    ? raw.supportedGenerationMethods
    : [];
  if (!name.startsWith('models/gemini') || !methods.includes('generateContent')) return undefined;
  const id = name.slice('models/'.length);
  if (!id || id.length > 300) return undefined;
  const displayName = typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : id;
  const limits = {
    ...(limit(raw.outputTokenLimit) ? { maxOutputTokens: limit(raw.outputTokenLimit) } : {}),
    ...(limit(raw.inputTokenLimit) ? { inputTokenLimit: limit(raw.inputTokenLimit) } : {}),
  };
  return {
    id,
    name: displayName.slice(0, 400),
    capabilities: { tools: null, structuredOutput: null },
    priceRevision: null,
    ...(Object.keys(limits).length ? { limits } : {}),
  };
}
