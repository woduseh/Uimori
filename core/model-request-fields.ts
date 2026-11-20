import type { ModelSnapshot } from './product.js';
import type { ProviderRequest } from './transport.js';

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
