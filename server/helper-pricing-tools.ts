import type { Json, ProviderTool } from '../core/transport.js';
import type { Connection, ModelPreset } from '../core/product.js';
import {
  resolveModelPricing,
  validateJudgmentPricing,
  validateModelPricing,
} from '../core/model-pricing.js';
import {
  DEFAULT_JUDGMENT_SELECTION,
  isJudgmentConnection,
  judgmentPriceFor,
  judgmentPriceKey,
  judgmentPriceTarget,
  judgmentPricingRates,
  judgmentPricingSnapshot,
  judgmentProtocol,
  type JudgmentPriceEntry,
  type JudgmentPriceTarget,
  type JudgmentPricing,
} from '../core/judgment-settings.js';
import { JEV_ENDPOINT } from './judgment.js';
import {
  modelWorkspace,
  updateModelWorkspace,
  validateJudgmentPriceTarget,
} from './prompt-workspace.js';
import { HelperToolError } from './app-errors.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';
import { backfillUnpricedCalls, backfillUnpricedJudgmentCalls } from './usage-backfill.js';

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
    'true targets a judgment provider price instead of a saved model: by default the provider chosen in the role settings, or judgmentTarget. Give either modelId or judgment.',
};
const judgmentTarget: Json = {
  type: 'object',
  description:
    'Optional with judgment:true: the judgmentTarget of an entry in storedTargets from model.pricing.read, {provider, modelId} or for compatible formats {provider, modelId, connectionId}. Omit for the provider chosen now.',
  properties: {
    provider: {
      type: 'string',
      enum: ['typesafe', 'openai', 'gemini', 'openai-compatible', 'typesafe-compatible'],
    },
    modelId: { type: 'string', minLength: 1, maxLength: 200 },
    connectionId: { type: 'string', minLength: 1, maxLength: 100 },
  },
  required: ['provider', 'modelId'],
  additionalProperties: false,
};
const rate = { type: ['number', 'null'], minimum: 0, maximum: 1e6 } as Json;
const rates = schema(
  { input: rate, output: rate, cacheRead: rate, cacheWrite: rate, cacheWrite1h: rate },
  ['input', 'output', 'cacheRead', 'cacheWrite']
);
const sameRates = (description: string): Json => ({
  type: 'object',
  description: `${description} Same fields as rates.`,
});
const context = schema(
  {
    aboveInputTokens: {
      type: 'integer',
      minimum: 1,
      maximum: 100000000,
      description: 'Input token count above which these rates apply.',
    },
    rates: sameRates('Rates above the threshold.'),
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
      'Read the pricing saved for one model, or with judgment:true for a judgment provider (lore selection, refusal checks, image placement and similar yes/no or choice calls): its configuration, the rates currently in effect and the revision needed by model.pricing.update. Judgment prices are kept per target: provider and model, plus the connection for the compatible formats. The result describes the provider chosen now (or judgmentTarget), says whether it is the current one, and lists storedTargets, every target that has a saved price. providerHost names the service whose prices apply; credentials and endpoint paths are not included. rateFields lists the rates a judgment target can use. A missing price means unknown, not free. Calls that are already reserved or finished keep the prices they were recorded with; model.pricing.backfill prices the past calls that had none.',
    inputSchema: schema({ modelId, judgment, judgmentTarget }),
  },
  {
    name: 'model.pricing.update',
    description:
      'Change the token prices saved for one model, or with judgment:true for the judgment provider. Read model.pricing.read for expectedRevision and the actual service and protocol, then take rates only from the user or from the official pricing page of that exact service that you actually read; never estimate or guess a price. A manual update requires sourceUrl and checkedAt. Rates are USD per million tokens: null means unknown and 0 means verified free, for example an output price the provider states is free. Record Flex, Batch, cache TTL and long-context rates separately where published, and leave unverified rates unchanged. A judgment target takes only the rates in rateFields, with no Flex, Batch or long-context rates; pricing null removes the price of that one target. This operation does not browse; use web search for the source. Changes apply to future requests and do not affect model options. Past calls keep the prices they were recorded with; backfill:true, or model.pricing.backfill later, fills in the ones that were recorded without any price, only when the user asks for it.',
    inputSchema: schema(
      {
        modelId,
        judgment,
        judgmentTarget,
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
                flexRates: sameRates('Flex tier rates, when published.'),
                batchRates: sameRates('Batch rates, when published.'),
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
        backfill: {
          type: 'boolean',
          description:
            'true also runs model.pricing.backfill with the new price in the same save and returns its counts as backfill. Use it only when the user asks for past unknown costs to be filled in.',
        },
      },
      ['expectedRevision', 'pricing']
    ),
  },
  {
    name: 'model.pricing.backfill',
    description:
      'Estimate the cost of past calls of one model, or with judgment:true of one judgment target, that were recorded without any price, using the price saved for it now. Use it after saving a price when the user wants earlier unknown costs filled in. Only calls with no recorded price and no provider-reported cost change; calls that already have a price keep it, and a judgment backfill touches only judgment calls of that exact target, never chat calls. Judgment calls whose stored record no longer names their format stay unknown unless they ran on TypeSafe JEV. Each filled estimate is marked as priced after the call, so running it again changes nothing. The result counts the calls that became estimated or partial, the ones that stay unknown (for example a different service tier) and the USD added to the usage report.',
    inputSchema: schema({ modelId, judgment, judgmentTarget }),
  },
];

const backfillFields = (result: Record<string, unknown>) =>
  Object.fromEntries(
    ['unpricedCalls', 'estimatedCalls', 'partialCalls', 'stillUnknownCalls', 'addedUsd'].map(
      (key) => [key, result[key]]
    )
  );

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
    throw new HelperToolError(400, 'UNKNOWN_PRICING_TOOL');
  const target = ['modelId', 'judgment', 'judgmentTarget'];
  fields(
    args,
    name === 'model.pricing.update'
      ? [...target, 'expectedRevision', 'pricing', 'backfill']
      : target
  );
  if (args.backfill !== undefined && typeof args.backfill !== 'boolean')
    throw new HttpError(400, 'Invalid backfill');
  if (args.judgment !== undefined || args.judgmentTarget !== undefined) {
    if (args.judgment !== true || args.modelId !== undefined)
      throw new HelperToolError(
        400,
        'PRICING_TARGET_INVALID',
        'Give either modelId or judgment:true.'
      );
    const result = judgmentPricingTool(store, name, args) as Record<string, unknown>;
    return args.backfill === true
      ? {
          ...result,
          backfill: backfillFields(
            judgmentPricingTool(store, 'model.pricing.backfill', args) as Record<string, unknown>
          ),
        }
      : result;
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
      throw new HelperToolError(400, 'INVALID_MODEL_PRICING');
    }
    if (pricing.mode === 'manual' && (!pricing.sourceUrl || !pricing.checkedAt))
      throw new HelperToolError(400, 'PRICING_SOURCE_REQUIRED');
    model = store.product.save(
      'model',
      { ...model, pricing },
      modelId,
      expectedRevision
    ) as ModelPreset;
  }
  const backfill =
    name === 'model.pricing.update' && args.backfill === true
      ? backfillUnpricedCalls(store, modelId)
      : undefined;
  return {
    ...(backfill ? { backfill } : {}),
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
  const current = modelWorkspace(store);
  const chosen = judgmentPriceTarget(current.judgment ?? DEFAULT_JUDGMENT_SELECTION);
  const target =
    args.judgmentTarget === undefined ? chosen : validateJudgmentPriceTarget(args.judgmentTarget);
  const key = judgmentPriceKey(target);
  const describe = (entries: JudgmentPriceEntry[] | undefined) =>
    describeJudgmentTarget(store, target, judgmentPriceFor(entries, target));
  if (name === 'model.pricing.backfill') {
    const backfill = backfillUnpricedJudgmentCalls(
      store,
      target,
      judgmentPriceFor(current.judgmentPricing, target)
    );
    return { judgment: true, ...describe(current.judgmentPricing), ...backfill };
  }
  if (name === 'model.pricing.update') {
    if (target.connectionId && !pricedConnection(store, target))
      throw new HelperToolError(400, 'JUDGMENT_CONNECTION_INVALID');
    let pricing: JudgmentPricing | undefined;
    if (args.pricing !== null) {
      try {
        pricing = validateJudgmentPricing(args.pricing, target.provider);
      } catch {
        throw new HelperToolError(400, 'INVALID_MODEL_PRICING');
      }
      if (!pricing.sourceUrl || !pricing.checkedAt)
        throw new HelperToolError(400, 'PRICING_SOURCE_REQUIRED');
    }
    const others = (current.judgmentPricing ?? []).filter(
      (entry) => judgmentPriceKey(entry) !== key
    );
    updateModelWorkspace(store, {
      expectedRevision: number(args.expectedRevision, 'model workspace revision'),
      routes: current.routes,
      translationPolicy: current.translationPolicy,
      judgmentPricing: pricing ? [...others, { ...target, pricing }] : others,
    });
  }
  const workspace = modelWorkspace(store);
  return {
    judgment: true,
    revision: workspace.revision,
    current: key === judgmentPriceKey(chosen),
    ...describe(workspace.judgmentPricing),
    storedTargets: (workspace.judgmentPricing ?? []).map(({ pricing, ...stored }) => {
      const { effective: _effective, ...summary } = describeJudgmentTarget(store, stored, pricing);
      return summary;
    }),
  };
}

function pricedConnection(store: Store, target: JudgmentPriceTarget) {
  if (target.provider === 'typesafe' || store.product.isHidden('connection', target.connectionId!))
    return false;
  try {
    const connection = store.product.get<Connection>('connection', target.connectionId!);
    return isJudgmentConnection(target.provider, { ...connection, enabled: true });
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 404) return false;
    throw error;
  }
}

function describeJudgmentTarget(
  store: Store,
  target: JudgmentPriceTarget,
  pricing: JudgmentPricing | undefined
) {
  let connection: Connection | undefined;
  if (target.connectionId) {
    try {
      connection = store.product.get<Connection>('connection', target.connectionId);
    } catch (error) {
      if (!(error instanceof HttpError) || error.statusCode !== 404) throw error;
    }
  }
  return {
    judgmentTarget: target,
    provider: target.provider,
    providerModelId: target.modelId,
    connectionId: target.connectionId ?? null,
    connectionTitle: connection?.title ?? null,
    providerHost:
      target.provider === 'typesafe'
        ? hostname(JEV_ENDPOINT)
        : target.provider === 'openai'
          ? 'api.openai.com'
          : target.provider === 'gemini'
            ? 'generativelanguage.googleapis.com'
            : connection
              ? hostname(connection.endpoint)
              : null,
    protocol: judgmentProtocol(target.provider),
    rateFields: judgmentPricingRates(target.provider),
    pricing: pricing ?? null,
    effective: judgmentPricingSnapshot(target, pricing) ?? null,
  };
}
