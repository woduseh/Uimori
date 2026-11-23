import type { Connection, ModelPreset } from '../core/product.js';
import type { ProviderRequest } from '../core/transport.js';
import {
  generationFromModel,
  modelCapability,
  PROTOCOL_OPTION_VALUES,
  protocolOptionKeys,
  validateModelOptions,
} from '../core/model-capabilities.js';
import { contextBudgetForModel } from '../core/context-budget.js';
import { resolveTokenizerProfile } from '../core/tokenizer-profiles.js';
import { resolveModelPricing } from '../core/model-pricing.js';

export function titleRequest(
  model: ModelPreset,
  connection: Connection,
  input: { contract: string; task: string }
): ProviderRequest {
  const generation = generationFromModel(model);
  const keys = protocolOptionKeys(connection.protocol);
  if (keys.includes('cacheMode')) {
    generation.cacheMode = 'disabled';
    delete generation.cacheTtl;
  }
  const capability = modelCapability(connection.protocol, model.modelId);
  const lowest = <T extends string>(supported: readonly T[] | undefined, order: readonly T[]) =>
    order.find((value) => supported?.includes(value));
  const thinkingLevel = lowest(capability?.thinkingLevels, PROTOCOL_OPTION_VALUES.thinkingLevel);
  if (thinkingLevel && keys.includes('thinkingLevel')) generation.thinkingLevel = thinkingLevel;
  const reasoningEffort = lowest(
    capability?.reasoningEfforts,
    PROTOCOL_OPTION_VALUES.reasoningEffort
  );
  if (reasoningEffort && keys.includes('reasoningEffort'))
    generation.reasoningEffort = reasoningEffort;
  const outputEffort = lowest(capability?.outputEfforts, PROTOCOL_OPTION_VALUES.outputEffort);
  if (outputEffort && keys.includes('outputEffort')) generation.outputEffort = outputEffort;
  validateModelOptions(generation, connection.protocol);
  return {
    role: 'title',
    modelId: model.modelId,
    pricingSnapshot: resolveModelPricing(model, connection),
    ...(model.providerOptions !== undefined
      ? { providerOptions: structuredClone(model.providerOptions) }
      : {}),
    generation,
    contextBudget: contextBudgetForModel({
      ...model,
      connection,
      tokenizer: resolveTokenizerProfile({ ...model, connection }),
    }),
    stable: { contract: input.contract, tools: [] },
    input: { task: input.task, controls: {} },
  };
}
