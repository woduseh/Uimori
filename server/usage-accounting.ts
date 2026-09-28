import type { DatabaseSync } from 'node:sqlite';
import type { UsageKind } from '../core/usage-report.js';
import type { ProviderResult, WireRecord } from '../core/transport.js';
import type { CostEstimate } from '../core/pricing-types.js';

export function inferUsageKind(wire: Pick<WireRecord, 'role'> & Partial<WireRecord>): UsageKind {
  if (
    wire.judgment ||
    wire.protocol === 'typesafe-systemone-v1' ||
    wire.connectionId === 'typesafe-judgment'
  )
    return 'judgment';
  if (wire.agentId) return 'advisor';
  if (wire.nativeScript) return 'script';
  switch (wire.role) {
    case 'main':
      return 'writing';
    case 'translation':
      return 'translation';
    case 'context':
      return 'summary';
    case 'helper':
      return 'helper';
    case 'image':
    case 'illustration':
      return 'image';
    case 'title':
      return 'title';
    case 'script':
      return 'script';
    case 'status':
      return 'status';
    default:
      return 'unclassified';
  }
}
export function helperUsageKind(purpose: string): UsageKind {
  if (purpose.includes('context') || purpose.includes('compaction')) return 'summary';
  if (purpose.includes('artifact')) return 'helper-artifact';
  return 'helper';
}

/** No prompt, text, URLs, keys, reasoning, or authored notes are required for numeric accounting. */
export function usageOnlyWire(wire: Partial<WireRecord>): Partial<WireRecord> {
  const pricing = wire.pricingSnapshot;
  return {
    protocol: wire.protocol,
    role: wire.role,
    modelId: wire.modelId,
    pricingStartedAt: wire.pricingStartedAt,
    executionMode: wire.executionMode,
    ...(pricing ? { pricingSnapshot: { ...pricing, sourceUrl: undefined, notes: [] } } : {}),
  };
}
export function usageOnlyResult(result: ProviderResult, estimate: CostEstimate) {
  return {
    status: result.status,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: result.usage.costUsd,
    },
    estimatedCost: {
      status: estimate.status,
      usd: estimate.usd,
      subtotalUsd: estimate.subtotalUsd,
      lines: [],
      notes: [],
    },
    detailsOmitted: true,
  };
}
export function uncertainAttemptResult(cancelled = false): ProviderResult {
  return {
    status: cancelled ? 'cancelled' : 'error',
    text: '',
    toolCalls: [],
    refusal: null,
    opaqueState: null,
    error: { code: 'PROVIDER_OUTCOME_UNCERTAIN' },
    usage: { inputTokens: null, outputTokens: null, costUsd: null, raw: null, priceRevision: null },
  };
}

/** Detach before deleting content parents. A late result may still settle numeric usage, but
 * usage_detached prevents finishAttempt from restoring any deleted/private request or output. */
export function detachAttemptUsage(db: DatabaseSync, ids: string[]) {
  if (!ids.length) return;
  // SQLite discards payloads in place. Do not materialize megabytes of text in JS just
  // to retain a handful of numbers. A running request needs only its frozen pricing.
  db.prepare(`UPDATE attempts SET chat_id=NULL,run_id=NULL,job_id=NULL,usage_detached=1,
    request=CASE WHEN status='running' AND json_valid(request) THEN
      json_object('protocol',json_extract(request,'$.protocol'),'role',role,'modelId',model_id,
        'pricingStartedAt',json_extract(request,'$.pricingStartedAt'),
        'executionMode',json_extract(request,'$.executionMode'),
        'pricingSnapshot',CASE WHEN json_type(request,'$.pricingSnapshot')='object' THEN
          json_set(json_remove(json_extract(request,'$.pricingSnapshot'),'$.sourceUrl'),'$.notes',json('[]')) END)
      ELSE '{}' END,
    response=json_object('status',status,'detailsOmitted',json('true'),
      'estimatedCost',json_object('status',estimate_status,'usd',estimated_usd,
        'subtotalUsd',estimated_subtotal_usd,'lines',json('[]'),'notes',json('[]'))),
    raw_usage=NULL,price_revision=NULL,error=NULL
    WHERE id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(ids));
}
