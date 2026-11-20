import { modelCapability, validateModelOptions } from './model-capabilities.js';
import { ProviderContractError } from './provider-errors.js';
import type { ProviderProtocol } from './product.js';
import type { Json, ProviderRequest } from './transport.js';

export type ProviderCachePlan = {
  options: Record<string, Json>;
  breakpoint?: { field: 'cache_control' | 'prompt_cache_breakpoint'; value: Record<string, Json> };
  disabled: boolean;
  explicitLimit: number;
  automaticSuppressed?: true;
};

export function planProviderCache(
  request: ProviderRequest,
  protocol: ProviderProtocol
): ProviderCachePlan {
  const generation = request.generation;
  if (generation && (generation.cacheMode !== undefined || generation.cacheTtl !== undefined))
    validateModelOptions(generation, protocol);
  const mode = generation?.cacheMode;
  const supported =
    modelCapability(protocol, request.modelId)?.cacheModes?.includes('explicit') === true ||
    mode !== undefined;
  const disabled = mode === 'disabled';
  const authoredPoints = new Set(
    request.prompt?.cachePlan.map((point) => point.afterMessageId) ?? []
  ).size;
  const automaticSuppressed = supported && mode === 'automatic' && authoredPoints === 4;
  const automatic = mode === 'automatic' && !automaticSuppressed;
  const explicitLimit = automatic ? 3 : 4;
  if (supported && mode === 'automatic' && authoredPoints > 4)
    throw new ProviderContractError('PROMPT_CACHE_LIMIT');
  const ttl: Record<string, Json> =
    generation?.cacheTtl === undefined ? {} : { ttl: generation.cacheTtl };
  if (protocol === 'anthropic-messages-v1' && supported) {
    return {
      options: automatic ? { cache_control: { type: 'ephemeral', ...ttl } } : {},
      ...(!disabled
        ? { breakpoint: { field: 'cache_control' as const, value: { type: 'ephemeral', ...ttl } } }
        : {}),
      disabled,
      explicitLimit,
      ...(automaticSuppressed ? { automaticSuppressed: true } : {}),
    };
  }
  if (protocol === 'openai-responses-v1' && supported) {
    const wireMode = automatic
      ? 'implicit'
      : disabled || mode === 'explicit' || authoredPoints > 0
        ? 'explicit'
        : undefined;
    return {
      options: wireMode ? { prompt_cache_options: { mode: wireMode, ...ttl } } : {},
      ...(!disabled
        ? { breakpoint: { field: 'prompt_cache_breakpoint' as const, value: { mode: 'explicit' } } }
        : {}),
      disabled,
      explicitLimit,
      ...(automaticSuppressed ? { automaticSuppressed: true } : {}),
    };
  }
  return { options: {}, disabled: false, explicitLimit: 0 };
}
