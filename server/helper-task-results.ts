import type {
  HelperQuestion,
  HelperStatus,
  HelperTask,
  HelperTaskResult,
  HelperTaskResultsView,
} from '../core/helper.js';
import { providerCacheUsage } from '../core/provider-cache-usage.js';
import type { HelperWorkspace } from './helper-workspace.js';
import { HttpError } from './request-validation.js';
import type { Store } from './store.js';
import { readHelperChanges, recordHelperAction } from './helper-changes.js';
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
  for (const target of result.targets) {
    if (target.kind !== 'settings' || !target.setting) continue;
    const chatId = target.setting.startsWith('chat.') ? target.id : null;
    recordHelperAction(workspace.store, task, {
      domain: 'settings',
      targetId: `${target.setting}:${target.id}`,
      chatId,
      title: target.title,
      location: { kind: 'setting', setting: target.setting },
      action: 'update',
      anchor: { domain: 'settings', id: target.id, chatId, setting: target.setting },
      ...(target.before !== undefined && target.after !== undefined
        ? { value: { before: target.before, after: target.after } }
        : {}),
    });
  }
}

const numeric = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const tokens = (value: unknown): number | null => {
  const number = numeric(value);
  return number !== null && Number.isSafeInteger(number) ? number : null;
};

export function readHelperTaskResults(store: Store, taskId: string): HelperTaskResultsView {
  const task = store.db.prepare('SELECT status FROM helper_tasks WHERE id=?').get(taskId);
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
  const attemptRows = store.db
    .prepare(`SELECT a.id,h.purpose,a.status,a.input_tokens,a.output_tokens,a.cost_usd,
      json_extract(a.request,'$.protocol') AS protocol,a.raw_usage
      FROM helper_task_attempts h JOIN attempts a ON a.id=h.attempt_id
      WHERE h.task_id=? ORDER BY a.rowid`)
    .all(taskId);
  const attempts = attemptRows.map((row) => {
    const raw = row.raw_usage ? JSON.parse(String(row.raw_usage)) : null;
    const details = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const nativeUsage = details.tokenUsage?.[details.tokenUsageBasis === 'last' ? 'last' : 'total'];
    const inputTokens = tokens(row.input_tokens),
      outputTokens = tokens(row.output_tokens);
    return {
      id: String(row.id),
      purpose: String(row.purpose),
      status: String(row.status),
      inputTokens,
      outputTokens,
      costUsd: numeric(row.cost_usd),
      cachedInputTokens:
        providerCacheUsage(row.protocol, raw)?.readTokens ??
        tokens(nativeUsage?.cachedInputTokens) ??
        (inputTokens === 0 ? 0 : null),
      reasoningTokens:
        tokens(
          details.output_tokens_details?.reasoning_tokens ??
            details.completion_tokens_details?.reasoning_tokens ??
            details.thoughtsTokenCount ??
            nativeUsage?.reasoningOutputTokens
        ) ?? (outputTokens === 0 ? 0 : null),
      internalModelCalls: tokens(details.modelCalls),
    };
  });
  const latest = attemptRows.findLast((row) => row.purpose === 'helper');
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
  const suggestionRows = store.db
    .prepare(
      "SELECT data FROM helper_events WHERE task_id=? AND kind='web.search.suggestions' ORDER BY seq"
    )
    .all(taskId);
  const webSearchSuggestions = suggestionRows.flatMap((row) => {
    const value = JSON.parse(String(row.data)) as { html?: unknown };
    return typeof value.html === 'string' && value.html.length <= 65_536 ? [value.html] : [];
  });
  return {
    taskId,
    status: task.status as HelperStatus,
    results,
    changes: readHelperChanges(store.db, taskId),
    confirmations: readHelperConfirmations(store, taskId),
    ...(question ? { question } : {}),
    webSearchSuggestions,
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
