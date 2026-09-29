import { helperCallOperationId } from './helper-workspace.js';
import type { Json, ProviderTool } from '../core/transport.js';
import type { HelperTask } from '../core/helper.js';
import { HttpError, choice, fields, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

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
      'Find recent task IDs, including queued work with no provider attempt yet. Defaults to active work in the current chat; a library helper without a chat sees all work. Returns only kind, ID, chat ID, status, auxiliary kind and update time.',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: id,
        status: { type: 'string', enum: ['active', 'failed', 'all'] },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'task.inspect',
    description:
      'Inspect one known run, auxiliary job, illustration job or helper task by exact ID. Returns compact status, error, usage and available actions without manuscript or execution snapshots. For helpers, committedEffects lists durable receipt-backed effects (20 per page); pass nextOffset as effectsOffset. It confirms the recorded commit, not current resource state or task success. Missing tool/callId is unknown, and no receipt is not proof that an uncertain action had no effect. Inspection never retries a write.',
    inputSchema: {
      type: 'object',
      properties: { kind, id, effectsOffset: { type: 'integer', minimum: 0 } },
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
  diagnostics?: {
    attemptsByPurpose: {
      purpose: string;
      usage: NonNullable<TaskView['usage']>;
      unknownInputCalls: number;
      unknownOutputCalls: number;
      unknownCostCalls: number;
      /** A native turn can hide several model calls; null is unknown, never one call. */
      internalModelCalls: number | null;
      unknownInternalModelCallAttempts: number;
    }[];
    toolResultSizes: ToolMetrics & {
      byTool: (ToolMetrics & { name: string })[];
    };
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

function listTasks(store: Store, current: HelperTask, args: Record<string, unknown>) {
  fields(record(args), ['chatId', 'status', 'limit']);
  const status =
    args.status === undefined
      ? 'active'
      : choice(args.status, ['active', 'failed', 'all'], 'task status');
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
      UNION ALL SELECT 'job',id,chat_id,status,kind,updated_at FROM jobs
      UNION ALL SELECT 'illustration',id,chat_id,status,NULL,updated_at FROM illustration_jobs
      UNION ALL SELECT 'helper',t.id,c.chat_id,t.status,NULL,t.updated_at
        FROM helper_tasks t JOIN helper_conversations c ON c.id=t.conversation_id
    ) WHERE (? IS NULL OR chatId=?)
      AND (?='all' OR (?='active' AND status IN ('queued','running'))
        OR (?='failed' AND status IN ('failed','interrupted','partial','cancelled','refused','stale')))
    ORDER BY updatedAt DESC,id DESC LIMIT ?`
    )
    .all(chatId, chatId, status, status, status, limit) as Row[];
  return { status, ...(chatId ? { chatId } : {}), tasks };
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
      const receiptId = `${taskId}:${helperCallOperationId(taskId, callId)}`;
      const item = pending.get(receiptId);
      if (!item) continue;
      item.tool = String(event.tool);
      item.callId = callId;
      pending.delete(receiptId);
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
  effectsOffset = 0
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
      diagnostics: helperDiagnostics(store, id),
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
      canCancel: active,
      canRetry: eligible,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    };
  }
  const illustration = row(
    store,
    'SELECT id,chat_id,status,error,created_at,updated_at FROM illustration_jobs WHERE id=?',
    id
  );
  const active = ['queued', 'running'].includes(illustration.status);
  const eligible = ['failed', 'cancelled', 'interrupted'].includes(illustration.status);
  return {
    kind: target,
    id,
    chatId: illustration.chat_id,
    status: illustration.status,
    error: illustration.error,
    usage: projectedUsage(
      store.db
        .prepare(
          `SELECT ${ATTEMPT_TOTALS} FROM attempts
       WHERE id IN (SELECT value FROM json_each((SELECT diagnostic FROM illustration_jobs WHERE id=?),'$.attempts'))`
        )
        .get(id) as Row
    ),
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
  fields(record(args), name === 'task.inspect' ? ['kind', 'id', 'effectsOffset'] : ['kind', 'id']);
  const target = choice(args.kind, ['run', 'job', 'illustration', 'helper'], 'task kind');
  const targetId = text(args.id, 'task ID', 100);
  const effectsOffset =
    name === 'task.inspect' ? number(args.effectsOffset ?? 0, 'effects offset', 0) : 0;
  const before = inspect(store, current.id, target, targetId, effectsOffset);
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
