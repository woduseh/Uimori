import type { DatabaseSync } from 'node:sqlite';
import type { UsageKind } from '../core/usage-report.js';
import type { ProviderResult, WireRecord } from '../core/transport.js';
import type { CostEstimate } from '../core/pricing-types.js';

export function inferUsageKind(
  wire: Pick<WireRecord, 'role'> & Partial<WireRecord>,
  archived = false
): UsageKind {
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
      return archived ? 'unclassified' : 'writing';
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
export function initUsageAccounting(db: DatabaseSync) {
  db.exec(`ALTER TABLE attempts ADD COLUMN started_at TEXT;
    ALTER TABLE attempts ADD COLUMN usage_kind TEXT NOT NULL DEFAULT 'unclassified';
    ALTER TABLE attempts ADD COLUMN is_synthetic INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE attempts ADD COLUMN usage_detached INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE attempts ADD COLUMN estimated_usd REAL;
    ALTER TABLE attempts ADD COLUMN estimated_subtotal_usd REAL;
    ALTER TABLE attempts ADD COLUMN estimate_status TEXT;
    CREATE INDEX attempts_usage_period ON attempts(is_synthetic,started_at);
    CREATE INDEX attempts_usage_model ON attempts(connection_id,model_id,started_at);
    UPDATE attempts SET
      started_at=CASE WHEN json_valid(request) THEN strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(request,'$.pricingStartedAt')) END,
      is_synthetic=(status='mock'),
      estimated_usd=CASE WHEN json_valid(response) AND json_type(response,'$.estimatedCost.usd') IN ('integer','real') THEN json_extract(response,'$.estimatedCost.usd') END,
      estimated_subtotal_usd=CASE WHEN json_valid(response) AND json_type(response,'$.estimatedCost.subtotalUsd') IN ('integer','real') THEN json_extract(response,'$.estimatedCost.subtotalUsd') END,
      estimate_status=CASE WHEN json_valid(response) THEN json_extract(response,'$.estimatedCost.status') END;
  `);
  // Before this schema, connection tests kept a separate bounded journal. Import only
  // its proven send receipts; older or already-pruned tests cannot be reconstructed.
  db.exec(`INSERT INTO attempts(id,role,connection_id,model_id,status,request,response,input_tokens,output_tokens,cost_usd,
    started_at,usage_kind,usage_detached,estimated_usd,estimated_subtotal_usd,estimate_status)
    SELECT 'connection-test:'||id,'main',json_extract(body,'$.connectionId'),json_extract(body,'$.providerModelId'),status,'{}',
      json_object('detailsOmitted',json('true'),'estimatedCost',json_object('status',json_extract(body,'$.estimatedCost.status'),'usd',json_extract(body,'$.estimatedCost.usd'),'subtotalUsd',json_extract(body,'$.estimatedCost.subtotalUsd'),'lines',json('[]'),'notes',json('[]'))),
      json_extract(body,'$.usage.inputTokens'),json_extract(body,'$.usage.outputTokens'),json_extract(body,'$.usage.costUsd'),
      strftime('%Y-%m-%dT%H:%M:%fZ',sent_at),'connection-test',1,
      json_extract(body,'$.estimatedCost.usd'),json_extract(body,'$.estimatedCost.subtotalUsd'),json_extract(body,'$.estimatedCost.status')
    FROM provider_connection_tests WHERE sent_at IS NOT NULL AND json_valid(body)
      AND json_type(body,'$.connectionId')='text' AND json_type(body,'$.providerModelId')='text';`);
  // Read only attribution fields, not full retained prompts. Missing old evidence stays unknown.
  const rows = db
    .prepare(`SELECT a.id,a.role,a.connection_id,a.model_id,
    CASE WHEN json_valid(a.request) THEN json_object('protocol',json_extract(a.request,'$.protocol'),'agentId',json_extract(a.request,'$.agentId'),
      'judgment',json_extract(a.request,'$.judgment'),'nativeScript',json_extract(a.request,'$.nativeScript'),'detailsOmitted',json_extract(a.request,'$.detailsOmitted')) ELSE '{}' END AS metadata,
    h.purpose FROM attempts a LEFT JOIN helper_task_attempts h ON h.attempt_id=a.id`)
    .all();
  for (const row of rows) {
    if (String(row.id).startsWith('connection-test:')) continue;
    const meta = JSON.parse(String(row.metadata));
    const inferred = row.purpose
      ? helperUsageKind(String(row.purpose))
      : inferUsageKind(
          { ...meta, role: row.role, connectionId: row.connection_id },
          !!meta.detailsOmitted
        );
    db.prepare('UPDATE attempts SET usage_kind=? WHERE id=?').run(inferred, row.id);
  }
  db.prepare("INSERT OR IGNORE INTO app_metadata(key,value) VALUES('usage-coverage-since',?)").run(
    new Date().toISOString()
  );
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
