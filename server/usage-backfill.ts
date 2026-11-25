import { resolveModelPricing } from '../core/model-pricing.js';
import { estimateCost } from '../core/pricing-estimate.js';
import type { Connection, ModelPreset } from '../core/product.js';
import type { PricingSnapshot } from '../core/pricing-types.js';
import {
  judgmentPricingSnapshot,
  type JudgmentPriceTarget,
  type JudgmentPricing,
} from '../core/judgment-settings.js';
import { DEFAULT_JUDGMENT_TARGET } from './judgment.js';
import { HttpError } from './request-validation.js';
import type { Store } from './store.js';

export const PRICED_AFTER_CALL = 'PRICED_AFTER_CALL';

export type UsageBackfill = {
  unpricedCalls: number;
  estimatedCalls: number;
  partialCalls: number;
  stillUnknownCalls: number;
  addedUsd: number;
};

const unpriced = `is_synthetic=0 AND status!='running'
  AND (cost_usd IS NULL OR cost_usd<0) AND COALESCE(estimate_status,'unavailable')='unavailable'
  AND json_type(request,'$.pricingSnapshot') IS NULL`;

export function backfillUnpricedCalls(store: Store, modelId: string): UsageBackfill {
  const model = store.product.get<ModelPreset>('model', modelId);
  const connection = store.product.get<Connection>('connection', model.connectionId);
  const pricing = resolveModelPricing(model, connection);
  if (!pricing) throw new HttpError(409, 'PRICING_UNAVAILABLE: Save a price for this model first.');
  return store.transaction(() =>
    priceRows(
      store,
      pricing,
      store.db
        .prepare(
          `SELECT id,input_tokens,output_tokens,raw_usage,json_extract(request,'$.executionMode') AS mode
           FROM attempts WHERE connection_id=? AND model_id=? AND usage_kind!='judgment' AND ${unpriced}`
        )
        .all(connection.id, model.modelId)
    )
  );
}

export function backfillUnpricedJudgmentCalls(
  store: Store,
  target: JudgmentPriceTarget,
  pricing: JudgmentPricing | undefined
): UsageBackfill {
  const snapshot = judgmentPricingSnapshot(target, pricing);
  if (!snapshot)
    throw new HttpError(409, 'PRICING_UNAVAILABLE: Save a price for this judgment target first.');
  return store.transaction(() =>
    priceRows(
      store,
      snapshot,
      store.db
        .prepare(
          `SELECT id,input_tokens,output_tokens,raw_usage,NULL AS mode
           FROM attempts WHERE usage_kind='judgment' AND model_id=? AND ${unpriced}
             AND (json_extract(request,'$.protocol')=?
               OR (json_extract(request,'$.protocol') IS NULL AND connection_id=?))
             AND (? IS NULL OR connection_id=?)`
        )
        .all(
          target.modelId,
          snapshot.protocol,
          target.provider === 'typesafe' ? DEFAULT_JUDGMENT_TARGET.connectionId : null,
          target.connectionId ?? null,
          target.connectionId ?? null
        )
    )
  );
}

function priceRows(
  store: Store,
  pricing: PricingSnapshot,
  rows: Record<string, unknown>[]
): UsageBackfill {
  const update = store.db.prepare(
    `UPDATE attempts SET estimated_usd=?,estimated_subtotal_usd=?,estimate_status=?,
       response=json_set(response,'$.estimatedCost',json(?)),
       request=CASE WHEN usage_detached=1 THEN request ELSE json_set(request,'$.pricingSnapshot',json(?)) END
     WHERE id=?`
  );
  const result: UsageBackfill = {
    unpricedCalls: rows.length,
    estimatedCalls: 0,
    partialCalls: 0,
    stillUnknownCalls: 0,
    addedUsd: 0,
  };
  for (const row of rows) {
    const estimate =
      row.mode === 'batch' && pricing.serviceTier !== 'batch'
        ? undefined
        : estimateCost(pricing, {
            inputTokens: row.input_tokens as number | null,
            outputTokens: row.output_tokens as number | null,
            raw: row.raw_usage === null ? null : JSON.parse(String(row.raw_usage)),
          });
    if (!estimate || estimate.status === 'unavailable') {
      result.stillUnknownCalls++;
      continue;
    }
    update.run(
      estimate.usd,
      estimate.subtotalUsd,
      estimate.status,
      JSON.stringify({ ...estimate, notes: [...estimate.notes, PRICED_AFTER_CALL] }),
      JSON.stringify(pricing),
      String(row.id)
    );
    if (estimate.status === 'estimated') result.estimatedCalls++;
    else result.partialCalls++;
    result.addedUsd += estimate.usd ?? estimate.subtotalUsd;
  }
  return result;
}
