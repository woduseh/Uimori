import type {
  HelperQuestion,
  HelperStatus,
  HelperTask,
  HelperTaskResult,
  HelperTaskResultsView,
} from '../core/helper.js';
import type { HelperWorkspace } from './helper-workspace.js';
import { helperTraceCalls } from './task-trace.js';
import { AppError } from './app-errors.js';
import type { Store } from './store.js';
import { readHelperConfirmations } from './helper-confirmations.js';

export function recordHelperTaskResult(
  workspace: HelperWorkspace,
  task: Pick<HelperTask, 'id' | 'conversationId'>,
  result: Omit<HelperTaskResult, 'eventSeq' | 'changedTargets'>
) {
  workspace.event(task.conversationId, task.id, 'operation.result', {
    ...result,
    changedTargets: result.targets.length,
  });
}

const numeric = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const tokens = (value: unknown): number | null => {
  const number = numeric(value);
  return number !== null && Number.isSafeInteger(number) ? number : null;
};

export function readHelperTaskResults(store: Store, taskId: string): HelperTaskResultsView {
  const task = store.db.prepare('SELECT status FROM helper_tasks WHERE id=?').get(taskId);
  if (!task) throw new AppError(404, 'HELPER_TASK_NOT_FOUND');
  const rows = store.db
    .prepare(`SELECT e.seq,e.data FROM helper_events e JOIN helper_operations o
      ON o.task_id=e.task_id AND o.id=json_extract(e.data,'$.receiptId')
      WHERE e.task_id=? AND e.kind='operation.result' ORDER BY e.seq`)
    .all(taskId);
  const results = rows.map((row) => ({
    ...(JSON.parse(String(row.data)) as Omit<HelperTaskResult, 'eventSeq'>),
    eventSeq: Number(row.seq),
  }));
  const unknown = store.db
    .prepare(`SELECT COUNT(*) AS n FROM helper_operations o WHERE o.task_id=? AND NOT EXISTS (
      SELECT 1 FROM helper_events e WHERE e.task_id=o.task_id AND e.kind='operation.result'
      AND json_extract(e.data,'$.receiptId')=o.id)`)
    .get(taskId);
  const attempts = helperTraceCalls(store, taskId);
  const latest = store.db
    .prepare(`SELECT a.input_tokens,a.raw_usage,json_extract(a.request,'$.protocol') AS protocol
      FROM helper_task_attempts h JOIN attempts a ON a.id=h.attempt_id
      WHERE h.task_id=? AND h.purpose='helper' ORDER BY a.rowid DESC LIMIT 1`)
    .get(taskId);
  const latestRaw = latest?.raw_usage ? JSON.parse(String(latest.raw_usage)) : null;
  const latestInputTokens =
    latest?.protocol === 'codex-app-server-v1'
      ? tokens(latestRaw?.tokenUsage?.last?.inputTokens)
      : tokens(latest?.input_tokens);
  const tools = store.db
    .prepare("SELECT COUNT(*) AS n FROM helper_events WHERE task_id=? AND kind='tool.finished'")
    .get(taskId);
  const measured = store.db
    .prepare(`SELECT json_extract(data,'$.estimatedInputTokens') AS tokens,
      json_extract(data,'$.knownInputTokens') AS known_tokens,
      json_extract(data,'$.unmeasuredFileCount') AS unmeasured_files,
      json_extract(data,'$.inputTokenLimit') AS input_limit,
      json_extract(data,'$.componentEstimates') AS parts,
      json_extract(data,'$.execution') AS execution FROM helper_events
      WHERE task_id=? AND kind='input.measured' ORDER BY seq DESC LIMIT 1`)
    .get(taskId);
  const inputLimit = tokens(measured?.input_limit);
  const parts = measured?.parts
    ? (JSON.parse(String(measured.parts)) as Record<string, unknown>)
    : null;
  const execution = measured?.execution;
  const questionRow = store.db
    .prepare(
      "SELECT data FROM helper_events WHERE task_id=? AND kind='question.asked' ORDER BY seq DESC LIMIT 1"
    )
    .get(taskId) as { data: unknown } | undefined;
  const question =
    typeof questionRow?.data === 'string' ? (JSON.parse(questionRow.data) as HelperQuestion) : null;
  return {
    taskId,
    status: task.status as HelperStatus,
    results,
    confirmations: readHelperConfirmations(store, taskId),
    ...(question ? { question } : {}),
    unrecordedOperations: Number(unknown?.n ?? 0),
    usage: {
      attempts,
      toolExecutions: Number(tools?.n ?? 0),
      latestInputTokens,
      latestInputEstimate: tokens(measured?.tokens),
      ...(Number(measured?.unmeasured_files ?? 0) > 0
        ? {
            knownInputEstimate: tokens(measured?.known_tokens),
            unmeasuredFileCount: Number(measured?.unmeasured_files),
          }
        : {}),
      latestInputLimit: inputLimit !== null && inputLimit > 0 ? inputLimit : null,
      latestInputParts: parts
        ? {
            instructions: tokens(parts.instructions),
            toolSchemas: tokens(parts.toolSchemas),
            history: tokens(parts.history),
            source: tokens(parts.source),
            toolResults: tokens(parts.toolResults),
          }
        : null,
      latestInputExecution:
        execution === 'codex-native' || execution === 'provider-tool-loop' ? execution : null,
    },
  };
}
