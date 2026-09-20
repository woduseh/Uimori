import type { Connection, ModelGeneration, ModelPreset } from '../core/product.js';
import type { ProviderRequest } from '../core/transport.js';
import {
  generationFromModel,
  protocolOptionKeys,
  validateModelOptions,
} from '../core/model-capabilities.js';
import { contextBudgetForModel } from '../core/context-budget.js';
import { resolveModelPricing } from '../core/model-pricing.js';

/** Title policy is independent of connection probes; neither mutates the saved model. */
export function titleRequest(
  model: ModelPreset,
  connection: Connection,
  input: { contract: string; task: string }
): ProviderRequest {
  const generation: ModelGeneration = { ...generationFromModel(model), maxOutputTokens: 256 };
  delete generation.thinkingBudgetTokens;
  if (protocolOptionKeys(connection.protocol).includes('cacheMode')) {
    generation.cacheMode = 'disabled';
    delete generation.cacheTtl;
  }
  validateModelOptions(generation, connection.protocol);
  return {
    role: 'title',
    modelId: model.modelId,
    pricingSnapshot: resolveModelPricing(model, connection),
    ...(model.providerOptions !== undefined
      ? { providerOptions: structuredClone(model.providerOptions) }
      : {}),
    generation,
    contextBudget: contextBudgetForModel({ ...model, connection }),
    stable: { contract: input.contract, tools: [] },
    input: { task: input.task, controls: {} },
  };
}
