import type { ModelSnapshot } from './product.js';
import type { ProviderRequest } from './transport.js';

/** Copy shared request metadata; generation and execution policy stay with each caller. */
export function modelRequestFields(
  model: Pick<ModelSnapshot, 'modelId' | 'providerOptions' | 'pricingSnapshot'>
): Pick<ProviderRequest, 'modelId' | 'providerOptions' | 'pricingSnapshot'> {
  return {
    modelId: model.modelId,
    pricingSnapshot: model.pricingSnapshot,
    ...(model.providerOptions !== undefined
      ? { providerOptions: structuredClone(model.providerOptions) }
      : {}),
  };
}
