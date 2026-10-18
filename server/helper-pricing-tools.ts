import type { Json, ProviderTool } from '../core/transport.js';
import type { Connection, ModelPreset } from '../core/product.js';
import { resolveModelPricing, validateModelPricing } from '../core/model-pricing.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

const schema = (properties: Record<string, Json>, required: string[] = []): Json => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const rate = { type: ['number', 'null'], minimum: 0, maximum: 1e6 } as Json;
const rates = schema(
  { input: rate, output: rate, cacheRead: rate, cacheWrite: rate, cacheWrite1h: rate },
  ['input', 'output', 'cacheRead', 'cacheWrite']
);
const context = schema(
  { aboveInputTokens: { type: 'integer', minimum: 1, maximum: 100000000 }, rates },
  ['aboveInputTokens', 'rates']
);
export const HELPER_PRICING_TOOLS: ProviderTool[] = [
  {
    name: 'model.pricing.read',
    description:
      'Read one saved model pricing configuration, current effective rates and model revision. Use model.list to discover saved IDs. Provider credentials and endpoint paths are omitted; providerHost identifies the actual pricing service. Missing prices mean unknown, never free. Reserved and past calls retain their frozen prices.',
    inputSchema: schema({ modelId: { type: 'string', minLength: 1, maxLength: 100 } }, ['modelId']),
  },
  {
    name: 'model.pricing.update',
    description:
      'Update only the pricing of a saved model after a user request. First read model.pricing.read for expectedRevision and actual connection/protocol. Verify rates for that actual connection from an official source; never substitute gateway prices for direct API prices. USD per million tokens; null means unknown, 0 means verified free. Manual updates require sourceUrl and checkedAt. Specify Flex, Batch, cache TTL and long-context rates separately when applicable; never infer a discount. This does not browse or change credentials, model options, reserved snapshots or historical costs. Legacy mode official selects only current connection catalog pricing.',
    inputSchema: schema(
      {
        modelId: { type: 'string', minLength: 1, maxLength: 100 },
        expectedRevision: { type: 'integer', minimum: 1 },
        pricing: {
          anyOf: [
            schema({ mode: { const: 'official', type: 'string' } }, ['mode']),
            schema(
              {
                mode: { const: 'manual', type: 'string' },
                rates,
                flexRates: rates,
                batchRates: rates,
                longContext: context,
                flexLongContext: context,
                batchLongContext: context,
                sourceUrl: { type: 'string', minLength: 1, maxLength: 2000 },
                checkedAt: { type: 'string', minLength: 10, maxLength: 40 },
              },
              ['mode', 'rates', 'sourceUrl', 'checkedAt']
            ),
          ],
        },
      },
      ['modelId', 'expectedRevision', 'pricing']
    ),
  },
];

/** Narrow model-price boundary; the helper never receives a writable model body or a credential. */
export function invokeHelperPricingTool(store: Store, name: string, value: unknown): unknown {
  const args = record(value);
  if (!['model.pricing.read', 'model.pricing.update'].includes(name))
    throw new HttpError(400, 'UNKNOWN_PRICING_TOOL');
  fields(
    args,
    name === 'model.pricing.read' ? ['modelId'] : ['modelId', 'expectedRevision', 'pricing']
  );
  const modelId = text(args.modelId, 'saved model ID', 100);
  store.product.assertAvailable('model', modelId);
  let model = store.product.get<ModelPreset>('model', modelId);
  const connection = store.product.get<Connection>('connection', model.connectionId);
  if (name === 'model.pricing.update') {
    const expectedRevision = number(args.expectedRevision, 'model revision', 1);
    let pricing: ReturnType<typeof validateModelPricing>;
    try {
      pricing = validateModelPricing(args.pricing);
    } catch {
      throw new HttpError(400, 'INVALID_MODEL_PRICING');
    }
    if (pricing.mode === 'manual' && (!pricing.sourceUrl || !pricing.checkedAt))
      throw new HttpError(400, 'PRICING_SOURCE_REQUIRED');
    model = store.product.save(
      'model',
      { ...model, pricing },
      modelId,
      expectedRevision
    ) as ModelPreset;
  }
  return {
    modelId: model.id,
    title: model.title,
    revision: model.revision,
    providerModelId: model.modelId,
    connectionId: model.connectionId,
    connectionTitle: connection.title,
    providerHost: (() => {
      try {
        return new URL(connection.endpoint).hostname;
      } catch {
        return null;
      }
    })(),
    protocol: connection.protocol,
    serviceTier: model.serviceTier ?? 'default',
    executionMode: model.executionMode ?? 'realtime',
    cacheTtl: model.cacheTtl ?? null,
    pricing: model.pricing ?? { mode: 'official' },
    effective: resolveModelPricing(model, connection) ?? null,
  };
}
