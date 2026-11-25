import { providerCacheUsage } from '../core/provider-cache-usage.js';
import {
  sumTraceCosts,
  traceCallKind,
  traceCostGroup,
  type ChatTraceCall,
  type TraceCall,
  type TraceCallOwner,
  type SceneTokens,
  type TraceCostTotal,
  type TraceToolCall,
} from '../core/task-trace.js';
import type { Store } from './store.js';

type Row = Record<string, unknown>;

const object = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
const tokenCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const amount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value: unknown) => (typeof value === 'string' ? value : null);

export function attemptUsageDetails(protocol: unknown, raw: unknown) {
  const details = object(raw);
  const native = object(
    object(details.tokenUsage)[details.tokenUsageBasis === 'last' ? 'last' : 'total']
  );
  return {
    cachedInputTokens:
      providerCacheUsage(protocol, raw)?.readTokens ?? tokenCount(native.cachedInputTokens),
    reasoningTokens: tokenCount(
      object(details.output_tokens_details).reasoning_tokens ??
        object(details.output_tokens_details).thinking_tokens ??
        object(details.completion_tokens_details).reasoning_tokens ??
        details.thoughtsTokenCount ??
        native.reasoningOutputTokens
    ),
    internalModelCalls: tokenCount(details.modelCalls),
  };
}

export const TRACE_ATTEMPT_COLUMNS = `a.id,a.run_id,a.job_id,a.role,a.usage_kind,a.connection_id,a.model_id,a.status,
  a.started_at,a.input_tokens,a.output_tokens,a.cost_usd,a.price_revision,a.error,
  json_extract(a.request,'$.judgment.kind') AS judgment_kind,
  json_extract(a.response,'$.executionDiagnostic.purpose') AS diagnostic_purpose,
  COALESCE(a.estimate_status,json_extract(a.response,'$.estimatedCost.status')) AS estimate_status,
  COALESCE(a.estimated_usd,json_extract(a.response,'$.estimatedCost.usd')) AS estimated_usd,
  COALESCE(a.estimated_subtotal_usd,json_extract(a.response,'$.estimatedCost.subtotalUsd'),0) AS estimated_subtotal_usd`;

export const TRACE_DETAIL_COLUMNS = `a.raw_usage,json_extract(a.request,'$.protocol') AS protocol,
  json_extract(a.response,'$.executionDiagnostic.elapsedMs') AS elapsed_ms,
  json_extract(a.response,'$.executionDiagnostic.firstByteMs') AS first_byte_ms`;

export function traceCall(
  row: Row,
  owner: TraceCallOwner,
  sceneRunId: string | null,
  tools: TraceToolCall[] = []
): TraceCall {
  const raw = typeof row.raw_usage === 'string' ? JSON.parse(row.raw_usage) : null;
  const inputTokens = tokenCount(row.input_tokens);
  const outputTokens = tokenCount(row.output_tokens);
  const usage = attemptUsageDetails(row.protocol, raw);
  const estimate = amount(row.estimated_usd);
  return {
    id: String(row.id),
    kind: traceCallKind({
      usageKind: text(row.usage_kind),
      role: String(row.role),
      judgmentKind: text(row.judgment_kind),
      diagnosticPurpose: text(row.diagnostic_purpose),
    }),
    owner,
    sceneRunId,
    ...(typeof row.purpose === 'string' ? { purpose: row.purpose } : {}),
    modelId: String(row.model_id),
    status: String(row.status),
    startedAt: text(row.started_at),
    elapsedMs: amount(row.elapsed_ms),
    firstByteMs: amount(row.first_byte_ms),
    inputTokens,
    outputTokens,
    cachedInputTokens: usage.cachedInputTokens ?? (inputTokens === 0 ? 0 : null),
    reasoningTokens: usage.reasoningTokens ?? (outputTokens === 0 ? 0 : null),
    internalModelCalls: usage.internalModelCalls,
    costUsd: amount(row.cost_usd),
    estimatedUsd: row.estimate_status === 'estimated' ? estimate : null,
    estimatedSubtotalUsd: amount(row.estimated_subtotal_usd) ?? 0,
    tools,
  };
}

const sceneScope = `WITH scope(attempt_id,scene_run_id,owner,rank,illustration_job_id) AS (
    SELECT a.id,a.run_id,'run',0,NULL FROM attempts a WHERE a.chat_id=?1 AND a.run_id IS NOT NULL
    UNION ALL
    SELECT a.id,s.run_id,'job',1,NULL FROM attempts a JOIN jobs j ON j.id=a.job_id
      JOIN sources s ON s.id=j.source_revision WHERE a.chat_id=?1 AND a.run_id IS NULL
    UNION ALL
    SELECT e.value,s.run_id,'illustration',2,i.id FROM illustration_jobs i JOIN sources s ON s.id=i.source_revision,
      json_each(i.diagnostic,'$.attempts') e
      WHERE i.chat_id=?1 AND json_valid(i.diagnostic) AND json_type(i.diagnostic,'$.attempts')='array'
  ), owned AS (
    SELECT attempt_id,scene_run_id,owner,illustration_job_id,MIN(rank) AS rank FROM scope GROUP BY attempt_id
  )`;

const diagnosticKinds: Record<string, string> = {
  illustration: 'image',
  writer: 'writing',
  advisor: 'advisor',
  'story-guide': 'story-guide',
  translation: 'translation',
};

function toolCall(data: Row): TraceToolCall {
  const shell = object(data.shell);
  return {
    name: typeof data.name === 'string' ? data.name : 'unknown',
    resultChars: tokenCount(data.providedResultChars),
    elapsedMs: amount(data.elapsedMs),
    failed:
      data.status === 'failed' ||
      (typeof shell.exitCode === 'number' && shell.exitCode !== 0) ||
      shell.timedOut === true ||
      typeof shell.signal === 'string' ||
      data.denied === true ||
      typeof data.errorKind === 'string',
  };
}

function executionTools(store: Store, chatId: string, rows: Row[]) {
  const diagnostics = store.db
    .prepare(`SELECT d.run_id,d.job_id,d.illustration_job_id,d.origin,d.data FROM execution_tool_diagnostics d
      WHERE d.run_id IN (SELECT id FROM runs WHERE chat_id=?1)
        OR d.job_id IN (SELECT id FROM jobs WHERE chat_id=?1)
        OR d.illustration_job_id IN (SELECT id FROM illustration_jobs WHERE chat_id=?1)
      ORDER BY d.seq`)
    .all(chatId) as Row[];
  const attemptsByOwner = new Map<unknown, Row[]>();
  for (const row of rows) {
    const owner = row.run_id ?? row.job_id ?? row.illustration_job_id;
    if (!owner) continue;
    const owned = attemptsByOwner.get(owner) ?? [];
    owned.push(row);
    attemptsByOwner.set(owner, owned);
  }
  const assigned = new Map<string, TraceToolCall[]>();
  for (const diagnostic of diagnostics) {
    const data = object(JSON.parse(String(diagnostic.data)));
    const at = text(data.startedAt) ?? text(data.finishedAt);
    const usageKind = diagnosticKinds[String(diagnostic.origin)];
    if (!at || !usageKind) continue;
    const column = diagnostic.run_id
      ? 'run_id'
      : diagnostic.job_id
        ? 'job_id'
        : 'illustration_job_id';
    const owner = diagnostic[column];
    const candidates = (attemptsByOwner.get(owner) ?? []).filter(
      (row) =>
        row[column] === owner &&
        row.usage_kind === usageKind &&
        typeof row.started_at === 'string' &&
        row.started_at <= at
    );
    const attempt =
      typeof data.attemptId === 'string'
        ? candidates.find((row) => row.id === data.attemptId)
        : diagnostic.origin === 'advisor' && candidates.length > 1
          ? undefined
          : candidates.at(-1);
    if (!attempt) continue;
    const list = assigned.get(String(attempt.id)) ?? [];
    list.push(toolCall(data));
    assigned.set(String(attempt.id), list);
  }
  return assigned;
}

export function chatTraceCalls(store: Store, chatId: string): ChatTraceCall[] {
  store.chat(chatId);
  const rows = store.db
    .prepare(`${sceneScope}
      SELECT ${TRACE_ATTEMPT_COLUMNS},${TRACE_DETAIL_COLUMNS},o.scene_run_id,o.owner,o.illustration_job_id
      FROM attempts a LEFT JOIN owned o ON o.attempt_id=a.id WHERE a.chat_id=?1 ORDER BY a.rowid`)
    .all(chatId) as Row[];
  const tools = executionTools(store, chatId, rows);
  return rows.map((row) => ({
    ...traceCall(
      row,
      (row.owner as TraceCallOwner | null) ?? 'chat',
      text(row.scene_run_id),
      tools.get(String(row.id))
    ),
    runId: text(row.run_id),
    jobId: text(row.job_id),
    role: String(row.role),
    connectionId: String(row.connection_id),
    priceRevision: text(row.price_revision),
    error: text(row.error),
  }));
}

export type SceneCosts = {
  estimatedCost: TraceCostTotal;
  sceneCost: TraceCostTotal;
  sceneTokens: SceneTokens;
};

function sumReportedTokens(calls: TraceCall[], field: 'inputTokens' | 'outputTokens') {
  return calls.reduce<number | null>(
    (total, call) => (call[field] === null ? total : (total ?? 0) + call[field]),
    null
  );
}

export function sceneCosts(store: Store, chatId: string, runIds?: string[]) {
  const rows = store.db
    .prepare(`${sceneScope}
      SELECT ${TRACE_ATTEMPT_COLUMNS},o.scene_run_id,o.owner FROM owned o JOIN attempts a ON a.id=o.attempt_id
      ${runIds ? 'WHERE o.scene_run_id IN (SELECT value FROM json_each(?2))' : ''} ORDER BY a.rowid`)
    .all(chatId, ...(runIds ? [JSON.stringify(runIds)] : [])) as Row[];
  const grouped = new Map<string, TraceCall[]>();
  for (const row of rows) {
    const runId = String(row.scene_run_id);
    const list = grouped.get(runId) ?? [];
    list.push(traceCall(row, row.owner as TraceCallOwner, runId));
    grouped.set(runId, list);
  }
  return new Map(
    [...grouped].map(([runId, calls]): [string, SceneCosts] => [
      runId,
      {
        estimatedCost: sumTraceCosts(calls.filter((call) => traceCostGroup(call) === 'writing')),
        sceneCost: sumTraceCosts(calls),
        sceneTokens: {
          inputTokens: sumReportedTokens(calls, 'inputTokens'),
          outputTokens: sumReportedTokens(calls, 'outputTokens'),
          inputPartial: calls.some((call) => call.inputTokens === null),
          outputPartial: calls.some((call) => call.outputTokens === null),
        },
      },
    ])
  );
}

export function helperTaskCosts(store: Store, taskIds: string[]) {
  if (!taskIds.length) return new Map<string, TraceCostTotal>();
  const rows = store.db
    .prepare(`SELECT ${TRACE_ATTEMPT_COLUMNS},h.task_id
      FROM helper_task_attempts h JOIN attempts a ON a.id=h.attempt_id
      WHERE h.task_id IN (SELECT value FROM json_each(?)) ORDER BY a.rowid`)
    .all(JSON.stringify(taskIds)) as Row[];
  const grouped = new Map<string, TraceCall[]>();
  for (const row of rows) {
    const list = grouped.get(String(row.task_id)) ?? [];
    list.push(traceCall(row, 'helper', null));
    grouped.set(String(row.task_id), list);
  }
  return new Map([...grouped].map(([taskId, calls]) => [taskId, sumTraceCosts(calls)]));
}

export function helperTraceCalls(store: Store, taskId: string): TraceCall[] {
  const rows = store.db
    .prepare(`SELECT ${TRACE_ATTEMPT_COLUMNS},${TRACE_DETAIL_COLUMNS},h.purpose
      FROM helper_task_attempts h JOIN attempts a ON a.id=h.attempt_id
      WHERE h.task_id=? ORDER BY a.rowid`)
    .all(taskId) as Row[];
  const events = store.db
    .prepare(`SELECT kind,data FROM helper_events WHERE task_id=?
      AND kind IN ('attempt.started','tool.finished') ORDER BY seq`)
    .all(taskId) as Row[];
  const tools = new Map<string, TraceToolCall[]>();
  let current: string | null = null;
  for (const event of events) {
    const data = object(JSON.parse(String(event.data)));
    if (event.kind === 'attempt.started') current = text(data.id);
    else if (current) {
      const list = tools.get(current) ?? [];
      list.push(toolCall(data));
      tools.set(current, list);
    }
  }
  return rows.map((row) => traceCall(row, 'helper', null, tools.get(String(row.id))));
}
