import type { Json, ProviderTool } from '../core/transport.js';
import type { Connection, ModelPreset } from '../core/product.js';
import {
  resolveModelPricing,
  validateJudgmentPricing,
  validateModelPricing,
} from '../core/model-pricing.js';
import {
  DEFAULT_JUDGMENT_SELECTION,
  TYPESAFE_JUDGMENT_MODEL,
  judgmentPricingRates,
  judgmentPricingSnapshot,
  judgmentProtocol,
  type JudgmentPricing,
} from '../core/judgment-settings.js';
import { JEV_ENDPOINT } from './judgment.js';
import { modelWorkspace, updateModelWorkspace } from './prompt-workspace.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';
import { backfillUnpricedCalls } from './usage-backfill.js';

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
const judgment: Json = {
  type: 'boolean',
  const: true,
  description:
    'true targets the judgment provider chosen in the role settings instead of a saved model. Give either modelId or judgment.',
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
      'Read the pricing saved for one model, or with judgment:true for the judgment provider (lore selection, refusal checks, image placement and similar yes/no or choice calls): its configuration, the rates currently in effect and the revision needed by model.pricing.update. providerHost names the service whose prices apply; credentials and endpoint paths are not included. For the judgment provider, rateFields lists the rates its calls can use. A missing price means unknown, not free. Calls that are already reserved or finished keep the prices they were recorded with; model.pricing.backfill prices the past calls of a saved model that had none.',
    inputSchema: schema({ modelId, judgment }),
  },
  {
    name: 'model.pricing.update',
    description:
      'Change the token prices saved for one model, or with judgment:true for the judgment provider. Read model.pricing.read for expectedRevision and the actual service and protocol, then take rates only from the user or from the official pricing page of that exact service that you actually read; never estimate or guess a price. A manual update requires sourceUrl and checkedAt. Rates are USD per million tokens: null means unknown and 0 means verified free, for example an output price the provider states is free. Record Flex, Batch, cache TTL and long-context rates separately where published, and leave unverified rates unchanged. The judgment provider takes only the rates in rateFields, with no Flex, Batch or long-context rates, and pricing null removes its price. This operation does not browse; use web search for the source. Changes apply to future requests and do not affect model options. Past calls keep the prices they were recorded with; model.pricing.backfill fills in the saved-model calls that were recorded without any price, and judgment calls are never repriced.',
    inputSchema: schema(
      {
        modelId,
        judgment,
        expectedRevision: {
          type: 'integer',
          minimum: 0,
          description:
            'revision from model.pricing.read: the model revision, or for the judgment provider the role settings revision.',
        },
        pricing: {
          description:
            'Either {mode:"manual", rates, sourceUrl, checkedAt, ...} with verified rates, {mode:"official"}, which only selects the pricing of the current connection catalog of a saved model, or null to remove the judgment provider price.',
          anyOf: [
            { type: 'null' },
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
      ['expectedRevision', 'pricing']
    ),
  },
  {
    name: 'model.pricing.backfill',
    description:
      'Estimate the cost of past calls of one model that were recorded without any price, using the price saved for the model now. Use it after saving a price when the user wants earlier unknown costs filled in. Only calls with no recorded price and no provider-reported cost change; calls that already have a price keep it. Each filled estimate is marked as priced after the call. The result counts the calls that became estimated or partial, the ones that stay unknown (for example a different service tier) and the USD added to the usage report.',
    inputSchema: schema({ modelId }, ['modelId']),
  },
];

const hostname = (endpoint: string) => {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return null;
  }
};

export function invokeHelperPricingTool(store: Store, name: string, value: unknown): unknown {
  const args = record(value);
  if (!['model.pricing.read', 'model.pricing.update', 'model.pricing.backfill'].includes(name))
    throw new HttpError(400, 'UNKNOWN_PRICING_TOOL');
  const target = name === 'model.pricing.backfill' ? ['modelId'] : ['modelId', 'judgment'];
  fields(
    args,
    name === 'model.pricing.update' ? [...target, 'expectedRevision', 'pricing'] : target
  );
  if (args.judgment !== undefined) {
    if (args.judgment !== true || args.modelId !== undefined)
      throw new HttpError(400, 'PRICING_TARGET_INVALID: Give either modelId or judgment:true.');
    return judgmentPricingTool(store, name, args);
  }
  const modelId = text(args.modelId, 'saved model ID', 100);
  store.product.assertAvailable('model', modelId);
  if (name === 'model.pricing.backfill')
    return { modelId, ...backfillUnpricedCalls(store, modelId) };
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
    providerHost: hostname(connection.endpoint),
    protocol: connection.protocol,
    serviceTier: model.serviceTier ?? 'default',
    executionMode: model.executionMode ?? 'realtime',
    cacheTtl: model.cacheTtl ?? null,
    pricing: model.pricing ?? { mode: 'official' },
    effective: resolveModelPricing(model, connection) ?? null,
  };
}

function judgmentPricingTool(store: Store, name: string, args: Record<string, unknown>) {
  if (name === 'model.pricing.update') {
    const current = modelWorkspace(store);
    const { pricing: _previous, ...selection } = current.judgment ?? DEFAULT_JUDGMENT_SELECTION;
    let pricing: JudgmentPricing | undefined;
    if (args.pricing !== null) {
      try {
        pricing = validateJudgmentPricing(args.pricing, selection.provider);
      } catch {
        throw new HttpError(400, 'INVALID_MODEL_PRICING');
      }
      if (!pricing.sourceUrl || !pricing.checkedAt)
        throw new HttpError(400, 'PRICING_SOURCE_REQUIRED');
    }
    updateModelWorkspace(store, {
      expectedRevision: number(args.expectedRevision, 'model workspace revision'),
      routes: current.routes,
      translationPolicy: current.translationPolicy,
      judgment: pricing ? { ...selection, pricing } : selection,
    });
  }
  const workspace = modelWorkspace(store);
  const selection = workspace.judgment ?? DEFAULT_JUDGMENT_SELECTION;
  let connection: Connection | undefined;
  if (selection.provider !== 'typesafe') {
    try {
      connection = store.product.get<Connection>('connection', selection.connectionId);
    } catch (error) {
      if (!(error instanceof HttpError) || error.statusCode !== 404) throw error;
    }
  }
  return {
    judgment: true,
    revision: workspace.revision,
    provider: selection.provider,
    providerModelId:
      selection.provider === 'typesafe' ? TYPESAFE_JUDGMENT_MODEL : selection.modelId,
    connectionId: selection.provider === 'typesafe' ? null : selection.connectionId,
    connectionTitle: connection?.title ?? null,
    providerHost:
      selection.provider === 'typesafe'
        ? hostname(JEV_ENDPOINT)
        : connection
          ? hostname(connection.endpoint)
          : null,
    protocol: judgmentProtocol(selection.provider),
    rateFields: judgmentPricingRates(selection.provider),
    pricing: selection.pricing ?? null,
    effective: judgmentPricingSnapshot(selection) ?? null,
  };
}
