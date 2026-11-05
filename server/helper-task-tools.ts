import { helperCallOperationId } from './helper-workspace.js';
import type { Json, ProviderTool } from '../core/transport.js';
import type { IllustrationDiagnostic, IllustrationJobInput } from '../core/illustration.js';
import type { HelperTask } from '../core/helper.js';
import { HttpError, choice, fields, number, record, text } from './request-validation.js';
import type { Store } from './store.js';
import { providerCacheUsage } from '../core/provider-cache-usage.js';

const id: Json = { type: 'string', minLength: 1, maxLength: 100 };
const kind: Json = { type: 'string', enum: ['run', 'job', 'illustration', 'helper'] };
const schema: Json = {
  type: 'object',
  properties: { kind, id },
  required: ['kind', 'id'],
  additionalProperties: false,
};

export const HELPER_TASK_TOOLS: ProviderTool[] = [
  {
    name: 'task.list',
    description:
      'Find recent task IDs, including queued work with no provider attempt yet. Filter by kind, status or chatId. Defaults to active work in the current chat; a library helper without a chat sees all work. Returns only kind, ID, chat ID, status, auxiliary kind and update time.',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: id,
        kind,
        status: { type: 'string', enum: ['active', 'failed', 'all'] },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'task.inspect',
    description:
      'Inspect one known run, auxiliary job, illustration job or helper task by exact ID. Returns compact status, error, usage and available actions without manuscript or execution snapshots. includeDiagnostics:true adds recorded, content-bounded provider and tool events (20 per page); use attemptsOffset and toolsOffset for later pages. Missing old records or timing are unknown, not evidence of no calls. Illustration inspection also reports the failed stage, target and available prompt status; includePrompt:true explicitly includes any stored prepared prompt (refusals may have none). For helpers, committedEffects lists durable receipt-backed effects (20 per page); pass nextOffset as effectsOffset. It confirms the recorded commit, not current resource state or task success. Missing tool/callId is unknown, and no receipt is not proof that an uncertain action had no effect. Inspection never retries a write.',
    inputSchema: {
      type: 'object',
      properties: {
        kind,
        id,
        effectsOffset: { type: 'integer', minimum: 0 },
        includePrompt: { type: 'boolean' },
        includeDiagnostics: { type: 'boolean' },
        attemptsOffset: { type: 'integer', minimum: 0 },
        toolsOffset: { type: 'integer', minimum: 0 },
      },
      required: ['kind', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'task.cancel',
    description:
      'Cancel one known active task after the user requests it. Running provider work is aborted by its existing owner. Cannot cancel this helper task.',
    inputSchema: schema,
  },
  {
    name: 'task.retry',
    description:
      'Retry one known eligible task after the user requests it. A run retry may fork a new chat; returns its new task and chat IDs. Cannot retry this helper task or replay committed helper effects.',
    inputSchema: schema,
  },
];

type Kind = 'run' | 'job' | 'illustration' | 'helper';
type Row = Record<string, any>;
type ToolMetrics = {
  calls: number;
  originalChars: number;
  providedChars: number;
  timedCalls: number;
  elapsedMs: number | null;
  queueMs: number | null;
};
type DiagnosticPage = {
  total: number;
  offset: number;
  items: Record<string, unknown>[];
  nextOffset: number | null;
};
type TaskView = {
  kind: Kind;
  id: string;
  chatId?: string;
  conversationId?: string;
  jobKind?: string;
  status: string;
  error: string | null;
  usage: {
    modelCalls: number;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
  } | null;
  committedEffects?: ReturnType<typeof inspectCommittedEffects>;
  illustration?: {
    task: string;
    sourceId: string;
    targetId: string | null;
    stage: string | null;
    hasPreparedPrompt: boolean;
    contentCheckStatus: string | null;
    unavailableReason: string | null;
    preparedPrompt?: { prompt: string; caption: string; negativePrompt: string } | null;
  };
  diagnostics?: {
    attemptsByPurpose?: {
      purpose: string;
      usage: NonNullable<TaskView['usage']>;
      unknownInputCalls: number;
      unknownOutputCalls: number;
      unknownCostCalls: number;
      /** A native turn can hide several model calls; null is unknown, never one call. */
      internalModelCalls: number | null;
      unknownInternalModelCallAttempts: number;
    }[];
    toolResultSizes?: ToolMetrics & {
      byTool: (ToolMetrics & { name: string })[];
    };
    attempts?: DiagnosticPage;
    tools?: DiagnosticPage;
  };
  canCancel: boolean;
  canRetry: boolean;
  retryBlock?: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskControlActions = {
  cancelRun: (id: string) => void;
  retryRun: (id: string, key: string) => { id: string };
  cancelJob: (id: string) => void;
  retryJob: (id: string) => { id: string };
  cancelIllustration: (id: string) => void;
  retryIllustration: (id: string) => void;
  cancelHelper: (id: string) => void;
  retryHelper: (id: string, key: string) => { id: string };
};

function row(store: Store, query: string, id: string): Row {
  const found = store.db.prepare(query).get(id) as Row | undefined;
  if (!found) throw new HttpError(404, 'TASK_NOT_FOUND');
  return found;
}

const ATTEMPT_TOTALS = `COUNT(*) AS calls,
  COALESCE(SUM(CASE WHEN input_tokens>=0 THEN input_tokens ELSE 0 END),0) AS known_input,
  COALESCE(SUM(CASE WHEN output_tokens>=0 THEN output_tokens ELSE 0 END),0) AS known_output,
  COALESCE(SUM(CASE WHEN cost_usd>=0 THEN cost_usd ELSE 0 END),0) AS known_cost,
  COALESCE(SUM(input_tokens IS NULL OR input_tokens<0),0) AS unknown_input,
  COALESCE(SUM(output_tokens IS NULL OR output_tokens<0),0) AS unknown_output,
  COALESCE(SUM(cost_usd IS NULL OR cost_usd<0),0) AS unknown_cost`;

function projectedUsage(aggregate: Row): NonNullable<TaskView['usage']> {
  const calls = Number(aggregate.calls);
  return {
    modelCalls: calls,
    inputTokens: calls && !aggregate.unknown_input ? Number(aggregate.known_input) : null,
    outputTokens: calls && !aggregate.unknown_output ? Number(aggregate.known_output) : null,
    costUsd: calls && !aggregate.unknown_cost ? Number(aggregate.known_cost) : null,
  };
}

function attemptUsage(store: Store, column: 'run_id' | 'job_id', id: string) {
  const aggregate = store.db
    .prepare(`SELECT ${ATTEMPT_TOTALS} FROM attempts WHERE ${column}=? AND role!='title'`)
    .get(id) as Row;
  return projectedUsage(aggregate);
}

function helperDiagnostics(store: Store, id: string): NonNullable<TaskView['diagnostics']> {
  const attempts = store.db
    .prepare(
      `SELECT h.purpose,${ATTEMPT_TOTALS},
        COALESCE(SUM(CASE WHEN json_type(a.raw_usage,'$.modelCalls') IN ('integer','real') THEN json_extract(a.raw_usage,'$.modelCalls') ELSE 0 END),0) AS known_internal,
        COALESCE(SUM(json_type(a.raw_usage,'$.modelCalls') IN ('integer','real')),0) AS reported_internal
       FROM helper_task_attempts h JOIN attempts a ON a.id=h.attempt_id
       WHERE h.task_id=? GROUP BY h.purpose ORDER BY h.purpose`
    )
    .all(id) as Row[];
  const tools = store.db
    .prepare(
      `SELECT json_extract(data,'$.name') AS name,COUNT(*) AS calls,
        COALESCE(SUM(json_extract(data,'$.originalResultChars')),0) AS original_chars,
        COALESCE(SUM(json_extract(data,'$.providedResultChars')),0) AS provided_chars,
        SUM(CASE WHEN json_type(data,'$.elapsedMs') IN ('integer','real') THEN 1 ELSE 0 END) AS timed_calls,
        SUM(json_extract(data,'$.elapsedMs')) AS elapsed_ms,
        SUM(CASE WHEN json_type(data,'$.queueMs') IN ('integer','real') THEN 1 ELSE 0 END) AS queued_calls,
        SUM(json_extract(data,'$.queueMs')) AS queue_ms
       FROM helper_events WHERE task_id=? AND kind='tool.finished'
         AND json_type(data,'$.providedResultChars')='integer'
       GROUP BY name ORDER BY original_chars DESC,name`
    )
    .all(id) as Row[];
  const byTool = tools.map((item) => ({
    name: String(item.name),
    calls: Number(item.calls),
    originalChars: Number(item.original_chars),
    providedChars: Number(item.provided_chars),
    timedCalls: Number(item.timed_calls),
    // Legacy events have no timing; an incomplete sum must not look like the full duration.
    elapsedMs: item.timed_calls === item.calls ? Number(item.elapsed_ms) : null,
    queueMs: item.queued_calls === item.calls ? Number(item.queue_ms) : null,
  }));
  const toolTotals = byTool.reduce<ToolMetrics>(
    (total, item) => ({
      calls: total.calls + item.calls,
      originalChars: total.originalChars + item.originalChars,
      providedChars: total.providedChars + item.providedChars,
      timedCalls: total.timedCalls + item.timedCalls,
      elapsedMs:
        total.elapsedMs === null || item.elapsedMs === null
          ? null
          : total.elapsedMs + item.elapsedMs,
      queueMs:
        total.queueMs === null || item.queueMs === null ? null : total.queueMs + item.queueMs,
    }),
    { calls: 0, originalChars: 0, providedChars: 0, timedCalls: 0, elapsedMs: 0, queueMs: 0 }
  );
  if (!toolTotals.calls) toolTotals.elapsedMs = toolTotals.queueMs = null;
  return {
    attemptsByPurpose: attempts.map((item) => ({
      purpose: String(item.purpose),
      usage: projectedUsage(item),
      unknownInputCalls: Number(item.unknown_input),
      unknownOutputCalls: Number(item.unknown_output),
      unknownCostCalls: Number(item.unknown_cost),
      internalModelCalls:
        Number(item.reported_internal) !== Number(item.calls) ? null : Number(item.known_internal),
      unknownInternalModelCallAttempts: Number(item.calls) - Number(item.reported_internal),
    })),
    toolResultSizes: {
      ...toolTotals,
      byTool: byTool.slice(0, 12),
    },
  };
}

const object = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
const tokenCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Native items remain in raw usage; inspection returns only bounded counts by type and outcome. */
function nativeActivitySummary(raw: Record<string, any>) {
  if (
    !raw.nativeActivity ||
    typeof raw.nativeActivity !== 'object' ||
    Array.isArray(raw.nativeActivity)
  )
    return null;
  const activity = object(raw.nativeActivity);
  const groups = new Map<string, Record<string, number>>();
  for (const item of [
    ...(Array.isArray(activity.items) ? activity.items : []),
    ...(Array.isArray(activity.contextCompactions) ? activity.contextCompactions : []),
  ]) {
    const value = object(item);
    if (
      ![
        'webSearch',
        'functionCallOutput',
        'imageGeneration',
        'plan',
        'sleep',
        'contextCompaction',
      ].includes(value.type)
    )
      continue;
    const status = ['running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(
      value.status
    )
      ? value.status
      : 'unknown';
    const group = groups.get(value.type) ?? {};
    group[status] = (group[status] ?? 0) + 1;
    groups.set(value.type, group);
  }
  return {
    byType: [...groups.entries()].map(([type, statuses]) => ({ type, statuses })),
    omittedItems: tokenCount(activity.omittedItems),
    omittedContextCompactions: tokenCount(activity.omittedContextCompactions),
  };
}

/** Details are opt-in so they never enlarge routine model prompts. */
function recordedDiagnostics(
  store: Store,
  kind: Kind,
  id: string,
  attemptsOffset: number,
  toolsOffset: number
) {
  const attemptWhere = {
    run: 'a.run_id=?',
    job: 'a.job_id=?',
    illustration:
      "a.id IN (SELECT value FROM json_each((SELECT diagnostic FROM illustration_jobs WHERE id=?),'$.attempts'))",
    helper: 'a.id IN (SELECT attempt_id FROM helper_task_attempts WHERE task_id=?)',
  }[kind];
  const attemptTotal = Number(
    store.db.prepare(`SELECT COUNT(*) AS n FROM attempts a WHERE ${attemptWhere}`).get(id)?.n ?? 0
  );
  const attemptRows = store.db
    .prepare(`SELECT a.id,a.role,a.usage_kind AS purpose,a.model_id AS modelId,
    a.status,a.started_at AS startedAt,a.input_tokens AS inputTokens,a.output_tokens AS outputTokens,
    a.cost_usd AS costUsd,a.error AS errorCode,a.raw_usage AS rawUsage,
    json_extract(a.request,'$.protocol') AS protocol,
    json_extract(a.response,'$.executionDiagnostic.purpose') AS detailPurpose,
    json_extract(a.response,'$.executionDiagnostic.finishedAt') AS finishedAt,
    json_extract(a.response,'$.executionDiagnostic.elapsedMs') AS elapsedMs
    FROM attempts a WHERE ${attemptWhere} ORDER BY a.rowid LIMIT 20 OFFSET ?`)
    .all(id, attemptsOffset) as Row[];
  const attemptItems = attemptRows.map((item) => {
    const { rawUsage, protocol, ...projection } = item;
    const raw = rawUsage ? object(JSON.parse(String(rawUsage))) : {};
    const nativeTokens = object(
      raw.tokenUsageBasis === 'last' || raw.tokenUsageBasis === 'total'
        ? object(raw.tokenUsage)[raw.tokenUsageBasis]
        : undefined
    );
    return {
      ...projection,
      errorCode:
        typeof item.errorCode === 'string' && /^[A-Z][A-Z0-9_]{1,95}$/u.test(item.errorCode)
          ? item.errorCode
          : null,
      cachedInputTokens:
        providerCacheUsage(protocol, raw)?.readTokens ?? tokenCount(nativeTokens.cachedInputTokens),
      reasoningTokens: tokenCount(
        object(raw.output_tokens_details).reasoning_tokens ??
          object(raw.completion_tokens_details).reasoning_tokens ??
          raw.thoughtsTokenCount ??
          nativeTokens.reasoningOutputTokens
      ),
      nativeActivity: nativeActivitySummary(raw),
    };
  });
  const attemptPage: DiagnosticPage = {
    total: attemptTotal,
    offset: attemptsOffset,
    items: attemptItems,
    nextOffset:
      attemptsOffset + attemptItems.length < attemptTotal
        ? attemptsOffset + attemptItems.length
        : null,
  };
  let toolTotal: number;
  let toolItems: Record<string, unknown>[];
  if (kind === 'helper') {
    // A start is not an outcome; a missing finish remains explicitly unknown. Older finished
    // events without a corresponding start are still visible without fabricating arguments.
    const pairs = `WITH pairs AS (
      SELECT s.seq,s.data AS started,(SELECT f.seq FROM helper_events f
        WHERE f.task_id=s.task_id AND f.kind='tool.finished' AND f.seq>s.seq
          AND json_extract(f.data,'$.callId')=json_extract(s.data,'$.callId') ORDER BY f.seq LIMIT 1) AS finished_seq
        FROM helper_events s WHERE s.task_id=? AND s.kind='tool.started'
      UNION ALL
      SELECT f.seq,NULL,f.seq FROM helper_events f WHERE f.task_id=? AND f.kind='tool.finished'
        AND NOT EXISTS (SELECT 1 FROM helper_events s WHERE s.task_id=f.task_id AND s.kind='tool.started'
          AND s.seq<f.seq AND json_extract(s.data,'$.callId')=json_extract(f.data,'$.callId'))
    )`;
    toolTotal = Number(
      store.db.prepare(`${pairs} SELECT COUNT(*) AS n FROM pairs`).get(id, id)?.n ?? 0
    );
    const rows = store.db
      .prepare(`${pairs}
      SELECT p.seq,p.started,f.seq AS finishedSeq,
        json_extract(f.data,'$.name') AS name,json_extract(f.data,'$.callId') AS callId,
        json_extract(f.data,'$.status') AS status,json_extract(f.data,'$.denied') AS denied,
        json_extract(f.data,'$.errorKind') AS errorKind,json_extract(f.data,'$.errorCode') AS errorCode,
        json_extract(f.data,'$.originalResultChars') AS originalResultChars,
        json_extract(f.data,'$.providedResultChars') AS providedResultChars,
        json_extract(f.data,'$.elapsedMs') AS elapsedMs,json_extract(f.data,'$.queueMs') AS queueMs,
        json_extract(f.data,'$.finishedAt') AS finishedAt,json_extract(f.data,'$.shell') AS shell
      FROM pairs p LEFT JOIN helper_events f ON f.seq=p.finished_seq ORDER BY p.seq LIMIT 20 OFFSET ?`)
      .all(id, id, toolsOffset) as Row[];
    toolItems = rows.map((item) => {
      const started = item.started
        ? (JSON.parse(String(item.started)) as Record<string, unknown>)
        : {};
      const keys = [
        'name',
        'callId',
        'startedAt',
        'argsPreview',
        'argsChars',
        'argsSha256',
        'argsTruncated',
        'argsRedacted',
      ];
      const event = Object.fromEntries(
        keys.filter((key) => key in started).map((key) => [key, started[key]])
      );
      const outcome =
        item.finishedSeq === null
          ? null
          : {
              status: item.status ?? null,
              denied: item.denied === null ? null : !!item.denied,
              errorKind: item.errorKind ?? null,
              errorCode: item.errorCode ?? null,
              originalResultChars: item.originalResultChars ?? null,
              providedResultChars: item.providedResultChars ?? null,
              elapsedMs: item.elapsedMs ?? null,
              queueMs: item.queueMs ?? null,
              finishedAt: item.finishedAt ?? null,
              shell: item.shell ? JSON.parse(String(item.shell)) : null,
            };
      return {
        seq: item.seq,
        name: item.name ?? event.name ?? null,
        callId: item.callId ?? event.callId ?? null,
        ...event,
        state: outcome ? 'finished' : 'started',
        ...(outcome ? {} : { effect: 'unknown' }),
        outcome,
      };
    });
  } else {
    const column = { run: 'run_id', job: 'job_id', illustration: 'illustration_job_id' }[kind];
    toolTotal = Number(
      store.db
        .prepare(`SELECT COUNT(*) AS n FROM execution_tool_diagnostics WHERE ${column}=?`)
        .get(id)?.n ?? 0
    );
    const rows = store.db
      .prepare(
        `SELECT seq,generation,origin,data FROM execution_tool_diagnostics WHERE ${column}=? ORDER BY seq LIMIT 20 OFFSET ?`
      )
      .all(id, toolsOffset) as Row[];
    toolItems = rows.map((item) => ({
      seq: item.seq,
      generation: item.generation,
      origin: item.origin,
      ...JSON.parse(String(item.data)),
    }));
  }
  const tools: DiagnosticPage = {
    total: toolTotal,
    offset: toolsOffset,
    items: toolItems,
    nextOffset: toolsOffset + toolItems.length < toolTotal ? toolsOffset + toolItems.length : null,
  };
  return { attempts: attemptPage, tools };
}

function listTasks(store: Store, current: HelperTask, args: Record<string, unknown>) {
  fields(record(args), ['chatId', 'kind', 'status', 'limit']);
  const status =
    args.status === undefined
      ? 'active'
      : choice(args.status, ['active', 'failed', 'all'], 'task status');
  const selectedKind =
    args.kind === undefined
      ? null
      : choice(args.kind, ['run', 'job', 'illustration', 'helper'], 'task kind');
  const limit = args.limit === undefined ? 10 : number(args.limit, 'task limit', 1, 20);
  const chatId =
    args.chatId === undefined
      ? current.snapshot.scope.kind === 'chat'
        ? current.snapshot.scope.chatId
        : null
      : text(args.chatId, 'chat ID', 100);
  if (chatId) store.chat(chatId);
  const tasks = store.db
    .prepare(
      `SELECT kind,id,chatId,status,jobKind,updatedAt FROM (
      SELECT 'run' AS kind,id,chat_id AS chatId,status,NULL AS jobKind,updated_at AS updatedAt FROM runs
      UNION ALL SELECT 'job',id,chat_id,status,kind,updated_at FROM jobs WHERE kind!='status'
      UNION ALL SELECT 'illustration',id,chat_id,status,NULL,updated_at FROM illustration_jobs
      UNION ALL SELECT 'helper',t.id,c.chat_id,t.status,NULL,t.updated_at
        FROM helper_tasks t JOIN helper_conversations c ON c.id=t.conversation_id
    ) WHERE (? IS NULL OR chatId=?)
      AND (? IS NULL OR kind=?)
      AND (?='all' OR (?='active' AND status IN ('queued','running'))
        OR (?='failed' AND status IN ('failed','interrupted','partial','cancelled','refused','stale')))
    ORDER BY updatedAt DESC,id DESC LIMIT ?`
    )
    .all(chatId, chatId, selectedKind, selectedKind, status, status, status, limit) as Row[];
  return {
    status,
    ...(selectedKind ? { kind: selectedKind } : {}),
    ...(chatId ? { chatId } : {}),
    tasks,
  };
}

type CommittedEffect = {
  receiptId: string;
  committed: true;
  tool: string | null;
  callId: string | null;
  createdAt: string;
};

/** Receipts establish commit; retained event metadata only supplies optional attribution. */
function inspectCommittedEffects(store: Store, taskId: string, offset: number) {
  const total = Number(
    store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations WHERE task_id=?').get(taskId)
      ?.n ?? 0
  );
  const rows = store.db
    .prepare(`SELECT id AS receiptId,created_at AS createdAt FROM helper_operations
    WHERE task_id=? ORDER BY rowid LIMIT 20 OFFSET ?`)
    .all(taskId, offset) as { receiptId: string; createdAt: string }[];
  const items: CommittedEffect[] = rows.map((row) => ({
    ...row,
    committed: true,
    tool: null,
    callId: null,
  }));
  const pending = new Map(items.map((item) => [item.receiptId, item]));
  if (pending.size) {
    // Never load results or infer a save from a successful/streamed event. Old pruned events
    // still retain callId/name; an interrupted save may legitimately have no event at all.
    for (const event of store.db
      .prepare(`SELECT json_extract(data,'$.name') AS tool,
      json_extract(data,'$.callId') AS callId FROM helper_events WHERE task_id=? AND kind='tool.finished'
      AND json_type(data,'$.name')='text' AND json_type(data,'$.callId')='text' ORDER BY seq`)
      .iterate(taskId)) {
      const callId = String(event.callId);
      const operationId = helperCallOperationId(taskId, callId);
      const exactReceiptId = `${taskId}:${operationId}`;
      // One data.exec call can apply several files. Native receipts extend the same
      // host-owned call identity with file/revision/content, never with result claims.
      const shellPrefix = `${taskId}:shell:${operationId}:`;
      const appPrefix = `${taskId}:shell:${operationId.slice(0, 48)}:app:`;
      for (const [receiptId, item] of pending) {
        if (
          receiptId !== exactReceiptId &&
          !(
            event.tool === 'data.exec' &&
            (receiptId.startsWith(shellPrefix) || receiptId.startsWith(appPrefix))
          )
        )
          continue;
        item.tool = String(event.tool);
        item.callId = callId;
        pending.delete(receiptId);
      }
      if (!pending.size) break;
    }
  }
  return {
    total,
    offset,
    items,
    nextOffset: offset + items.length < total ? offset + items.length : null,
  };
}

function inspect(
  store: Store,
  currentTaskId: string,
  target: Kind,
  id: string,
  effectsOffset = 0,
  includePrompt = false,
  includeDiagnostics = false,
  attemptsOffset = 0,
  toolsOffset = 0
): TaskView {
  if (target === 'helper') {
    const task = row(
      store,
      "SELECT id,conversation_id,status,error,usage,created_at,updated_at,COALESCE(json_extract(snapshot,'$.requestGroupId'),id) AS request_group FROM helper_tasks WHERE id=?",
      id
    );
    const self = id === currentTaskId;
    const eligible = ['failed', 'cancelled', 'interrupted'].includes(task.status);
    const committedEffects = inspectCommittedEffects(store, id, effectsOffset);
    const committed = eligible && committedEffects.total > 0;
    const latest = eligible
      ? (
          store.db
            .prepare(
              "SELECT id FROM helper_tasks WHERE conversation_id=? AND COALESCE(json_extract(snapshot,'$.requestGroupId'),id)=? ORDER BY rowid DESC LIMIT 1"
            )
            .get(task.conversation_id, task.request_group) as { id: string } | undefined
        )?.id === id
      : false;
    return {
      kind: target,
      id,
      conversationId: task.conversation_id,
      status: task.status,
      error: task.error,
      usage: JSON.parse(String(task.usage)),
      diagnostics: {
        ...helperDiagnostics(store, id),
        ...(includeDiagnostics
          ? recordedDiagnostics(store, target, id, attemptsOffset, toolsOffset)
          : {}),
      },
      committedEffects,
      canCancel: !self && ['queued', 'running'].includes(task.status),
      canRetry: !self && eligible && !committed && latest,
      ...(self
        ? { retryBlock: 'CURRENT_HELPER_TASK' }
        : committed
          ? { retryBlock: 'HELPER_EFFECTS_ALREADY_COMMITTED' }
          : eligible && !latest
            ? { retryBlock: 'HELPER_ALREADY_RETRIED' }
            : {}),
      createdAt: task.created_at,
      updatedAt: task.updated_at,
    };
  }
  if (target === 'run') {
    const run = row(
      store,
      "SELECT id,chat_id,status,error,created_at,updated_at,usage,json_extract(snapshot,'$.packageStart.mode') AS start_mode,json_extract(snapshot,'$.nativeRisuAuthored') AS native_authored FROM runs WHERE id=?",
      id
    );
    const active = ['queued', 'running'].includes(run.status);
    const authored = run.start_mode === 'authored' || !!run.native_authored;
    const usage = run.usage ? JSON.parse(String(run.usage)) : attemptUsage(store, 'run_id', id);
    return {
      kind: target,
      id,
      chatId: run.chat_id,
      status: run.status,
      error: run.error,
      usage,
      ...(includeDiagnostics
        ? { diagnostics: recordedDiagnostics(store, target, id, attemptsOffset, toolsOffset) }
        : {}),
      canCancel: active,
      canRetry: !active && !authored,
      ...(authored ? { retryBlock: 'AUTHORED_START' } : {}),
      createdAt: run.created_at,
      updatedAt: run.updated_at,
    };
  }
  if (target === 'job') {
    const job = row(
      store,
      'SELECT id,chat_id,kind,status,error,created_at,updated_at FROM jobs WHERE id=?',
      id
    );
    const active = ['queued', 'running'].includes(job.status);
    const eligible = ['failed', 'partial', 'interrupted', 'cancelled'].includes(job.status);
    return {
      kind: target,
      id,
      chatId: job.chat_id,
      jobKind: job.kind,
      status: job.status,
      error: job.error,
      usage: attemptUsage(store, 'job_id', id),
      ...(includeDiagnostics
        ? { diagnostics: recordedDiagnostics(store, target, id, attemptsOffset, toolsOffset) }
        : {}),
      canCancel: active,
      canRetry: eligible && job.kind !== 'status',
      ...(job.kind === 'status' ? { retryBlock: 'SCENE_COMMENTARY_RETIRED' } : {}),
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    };
  }
  const illustration = row(
    store,
    'SELECT id,chat_id,source_revision,status,error,input,diagnostic,created_at,updated_at FROM illustration_jobs WHERE id=?',
    id
  );
  const active = ['queued', 'running'].includes(illustration.status);
  const eligible = ['failed', 'cancelled', 'interrupted'].includes(illustration.status);
  const input = JSON.parse(String(illustration.input)) as IllustrationJobInput;
  const diagnostic = illustration.diagnostic
    ? (JSON.parse(String(illustration.diagnostic)) as IllustrationDiagnostic)
    : null;
  const preparedPrompt = diagnostic?.prompt ?? input.target?.prompt ?? null;
  return {
    kind: target,
    id,
    chatId: illustration.chat_id,
    status: illustration.status,
    error: illustration.error,
    illustration: {
      task: input.task ?? 'render',
      sourceId: illustration.source_revision,
      targetId: input.target?.id ?? null,
      stage: diagnostic?.stage ?? null,
      hasPreparedPrompt: !!preparedPrompt,
      contentCheckStatus: diagnostic?.contentCheck?.status ?? null,
      unavailableReason: diagnostic?.codex?.unavailableReason ?? null,
      ...(includePrompt ? { preparedPrompt } : {}),
    },
    usage: projectedUsage(
      store.db
        .prepare(
          `SELECT ${ATTEMPT_TOTALS} FROM attempts
       WHERE id IN (SELECT value FROM json_each((SELECT diagnostic FROM illustration_jobs WHERE id=?),'$.attempts'))`
        )
        .get(id) as Row
    ),
    ...(includeDiagnostics
      ? { diagnostics: recordedDiagnostics(store, target, id, attemptsOffset, toolsOffset) }
      : {}),
    canCancel: active,
    canRetry: eligible,
    createdAt: illustration.created_at,
    updatedAt: illustration.updated_at,
  };
}

export function invokeTaskTool(
  store: Store,
  current: HelperTask,
  name: string,
  args: Record<string, unknown>,
  operationId: string,
  actions: TaskControlActions
) {
  if (name === 'task.list') return listTasks(store, current, args);
  fields(
    record(args),
    name === 'task.inspect'
      ? [
          'kind',
          'id',
          'effectsOffset',
          'includePrompt',
          'includeDiagnostics',
          'attemptsOffset',
          'toolsOffset',
        ]
      : ['kind', 'id']
  );
  const target = choice(args.kind, ['run', 'job', 'illustration', 'helper'], 'task kind');
  const targetId = text(args.id, 'task ID', 100);
  const effectsOffset =
    name === 'task.inspect' ? number(args.effectsOffset ?? 0, 'effects offset', 0) : 0;
  if (
    name === 'task.inspect' &&
    args.includePrompt !== undefined &&
    typeof args.includePrompt !== 'boolean'
  )
    throw new HttpError(400, 'Invalid includePrompt');
  if (
    name === 'task.inspect' &&
    args.includeDiagnostics !== undefined &&
    typeof args.includeDiagnostics !== 'boolean'
  )
    throw new HttpError(400, 'Invalid includeDiagnostics');
  const attemptsOffset =
    name === 'task.inspect' ? number(args.attemptsOffset ?? 0, 'attempts offset', 0) : 0;
  const toolsOffset =
    name === 'task.inspect' ? number(args.toolsOffset ?? 0, 'tools offset', 0) : 0;
  const before = inspect(
    store,
    current.id,
    target,
    targetId,
    effectsOffset,
    args.includePrompt === true,
    args.includeDiagnostics === true,
    attemptsOffset,
    toolsOffset
  );
  if (name === 'task.inspect') return before;
  if (target === 'helper' && targetId === current.id)
    throw new HttpError(409, 'CURRENT_HELPER_TASK');
  if (name === 'task.cancel') {
    if (!before.canCancel) throw new HttpError(409, 'TASK_NOT_CANCELLABLE');
    if (target === 'run') actions.cancelRun(targetId);
    else if (target === 'job') actions.cancelJob(targetId);
    else if (target === 'illustration') actions.cancelIllustration(targetId);
    else actions.cancelHelper(targetId);
    return inspect(store, current.id, target, targetId);
  }
  if (name !== 'task.retry') throw new HttpError(400, 'UNKNOWN_HELPER_TOOL');
  if (!before.canRetry) throw new HttpError(409, before.retryBlock ?? 'TASK_NOT_RETRYABLE');
  let newId = targetId;
  if (target === 'run')
    newId = actions.retryRun(targetId, `helper:${current.id}:${operationId}`).id;
  else if (target === 'job') newId = actions.retryJob(targetId).id;
  else if (target === 'illustration') actions.retryIllustration(targetId);
  else newId = actions.retryHelper(targetId, `helper:${current.id}:${operationId}`).id;
  return { previousTaskId: targetId, task: inspect(store, current.id, target, newId) };
}
