import { modelCapability, validateModelOptions } from './model-capabilities.js';
import { ProviderContractError } from './provider-errors.js';
import type { ProviderProtocol } from './product.js';
import type { Json, ProviderRequest } from './transport.js';

export type ProviderCachePlan = {
  options: Record<string, Json>;
  breakpoint?: { field: 'cache_control' | 'prompt_cache_breakpoint'; value: Record<string, Json> };
  disabled: boolean;
  explicitLimit: number;
};

/** Cache policy only: the caller places authored points without rewriting content or signed turns. */
export function planProviderCache(
  request: ProviderRequest,
  protocol: ProviderProtocol
): ProviderCachePlan {
  const generation = request.generation;
  if (generation && (generation.cacheMode !== undefined || generation.cacheTtl !== undefined))
    validateModelOptions(generation, protocol);
  const mode = generation?.cacheMode;
  // A reviewed model documents cache support; an explicit user choice is honored on any model and
  // the provider answers if it disagrees. Unset mode on an unknown model leaves the provider default.
  const supported =
    modelCapability(protocol, request.modelId)?.cacheModes?.includes('explicit') === true ||
    mode !== undefined;
  const disabled = mode === 'disabled';
  const automatic = mode === 'automatic';
  const authoredPoints = new Set(
    request.prompt?.cachePlan.map((point) => point.afterMessageId) ?? []
  ).size;
  const explicitLimit = automatic ? 3 : 4;
  // A selected automatic point must not silently displace an authored point, even a preferred one.
  if (supported && automatic && authoredPoints > explicitLimit)
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
    };
  }
  return { options: {}, disabled: false, explicitLimit: 0 };
}
