import type {
  HelperStatus,
  HelperTask,
  HelperTaskResult,
  HelperTaskResultsView,
} from '../core/helper.js';
import { providerCacheUsage } from '../core/provider-cache-usage.js';
import type { HelperWorkspace } from './helper-workspace.js';
import { HttpError } from './request-validation.js';
import type { Store } from './store.js';

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

/** This projection reads confirmed event records, never guesses outcomes from streamed tool text. */
export function readHelperTaskResults(store: Store, taskId: string): HelperTaskResultsView {
  const task = store.db
    .prepare(`SELECT status,json_extract(snapshot,'$.model.inputTokenLimit') AS input_limit
      FROM helper_tasks WHERE id=?`)
    .get(taskId);
  if (!task) throw new HttpError(404, '도우미 작업을 찾을 수 없어요.');
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
  const attempts = store.db
    .prepare(`SELECT a.id,h.purpose,a.status,a.input_tokens,a.output_tokens,a.cost_usd,
      json_extract(a.request,'$.protocol') AS protocol,a.raw_usage
      FROM helper_task_attempts h JOIN attempts a ON a.id=h.attempt_id
      WHERE h.task_id=? ORDER BY a.rowid`)
    .all(taskId)
    .map((row) => {
      const raw = row.raw_usage ? JSON.parse(String(row.raw_usage)) : null;
      const details = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      return {
        id: String(row.id),
        purpose: String(row.purpose),
        status: String(row.status),
        inputTokens: tokens(row.input_tokens),
        outputTokens: tokens(row.output_tokens),
        costUsd: numeric(row.cost_usd),
        cachedInputTokens:
          providerCacheUsage(row.protocol, raw)?.readTokens ??
          tokens(details.tokenUsage?.total?.cachedInputTokens),
        reasoningTokens: tokens(
          details.output_tokens_details?.reasoning_tokens ??
            details.completion_tokens_details?.reasoning_tokens ??
            details.thoughtsTokenCount ??
            details.tokenUsage?.total?.reasoningOutputTokens
        ),
        internalModelCalls: tokens(details.modelCalls),
      };
    });
  const tools = store.db
    .prepare("SELECT COUNT(*) AS n FROM helper_events WHERE task_id=? AND kind='tool.finished'")
    .get(taskId);
  const measured = store.db
    .prepare(`SELECT json_extract(data,'$.estimatedInputTokens') AS tokens,
      json_extract(data,'$.inputTokenLimit') AS input_limit FROM helper_events
      WHERE task_id=? AND kind='input.measured' ORDER BY seq DESC LIMIT 1`)
    .get(taskId);
  const inputLimit = measured ? tokens(measured.input_limit ?? task.input_limit) : null;
  return {
    taskId,
    status: task.status as HelperStatus,
    results,
    unrecordedOperations: Number(unknown?.n ?? 0),
    usage: {
      attempts,
      toolExecutions: Number(tools?.n ?? 0),
      latestInputEstimate: tokens(measured?.tokens),
      latestInputLimit: inputLimit !== null && inputLimit > 0 ? inputLimit : null,
    },
  };
}
