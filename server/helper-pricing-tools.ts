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
const modelId: Json = {
  type: 'string',
  minLength: 1,
  maxLength: 100,
  description: 'Saved model id, from model.list.',
};
const rate = { type: ['number', 'null'], minimum: 0, maximum: 1e6 } as Json;
const rates = schema(
  { input: rate, output: rate, cacheRead: rate, cacheWrite: rate, cacheWrite1h: rate },
  ['input', 'output', 'cacheRead', 'cacheWrite']
);
const context = schema(
  {
    aboveInputTokens: {
      type: 'integer',
      minimum: 1,
      maximum: 100000000,
      description: 'Input token count above which these rates apply.',
    },
    rates,
  },
  ['aboveInputTokens', 'rates']
);
const described = (value: Json, description: string): Json => ({
  ...(value as Record<string, Json>),
  description,
});
export const HELPER_PRICING_TOOLS: ProviderTool[] = [
  {
    name: 'model.pricing.read',
    description:
      'Read the pricing saved for one model: its configuration, the rates currently in effect and the model revision needed by model.pricing.update. providerHost names the service whose prices apply; credentials and endpoint paths are not included. A missing price means unknown, not free. Calls that are already reserved or finished keep the prices they were recorded with.',
    inputSchema: schema({ modelId }, ['modelId']),
  },
  {
    name: 'model.pricing.update',
    description:
      'Change the token prices saved for one model. Read model.pricing.read for expectedRevision and the actual connection and protocol, then verify rates for that exact service from its official pricing page. A manual update requires sourceUrl and checkedAt. Rates are USD per million tokens: null means unknown and 0 means verified free. Record Flex, Batch, cache TTL and long-context rates separately where published, and leave unverified rates unchanged. This operation does not browse; use web search for the source. Changes apply to future requests and do not affect model options or past costs.',
    inputSchema: schema(
      {
        modelId,
        expectedRevision: {
          type: 'integer',
          minimum: 1,
          description: 'Model revision from model.pricing.read.',
        },
        pricing: {
          description:
            'Either {mode:"manual", rates, sourceUrl, checkedAt, ...} with verified rates, or {mode:"official"}, which only selects the pricing of the current connection catalog.',
          anyOf: [
            schema({ mode: { const: 'official', type: 'string' } }, ['mode']),
            schema(
              {
                mode: { const: 'manual', type: 'string' },
                rates: described(
                  rates,
                  'Standard rates in USD per million tokens: input, output, cacheRead, cacheWrite and optional cacheWrite1h. null is unknown, 0 is verified free.'
                ),
                flexRates: described(rates, 'Flex tier rates, when published.'),
                batchRates: described(rates, 'Batch rates, when published.'),
                longContext: described(context, 'Standard rates above a long-context threshold.'),
                flexLongContext: described(context, 'Flex rates above a long-context threshold.'),
                batchLongContext: described(context, 'Batch rates above a long-context threshold.'),
                sourceUrl: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 2000,
                  description: 'HTTPS URL of the official page the rates were taken from.',
                },
                checkedAt: {
                  type: 'string',
                  minLength: 10,
                  maxLength: 40,
                  description:
                    'When the page was checked: YYYY-MM-DD, or a UTC date-time ending in Z.',
                },
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
