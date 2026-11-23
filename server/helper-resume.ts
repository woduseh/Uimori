import type { DatabaseSync } from 'node:sqlite';
import type { ToolEvent } from '../core/types.js';

const resumeChain = (seed: string) => `chain(task_id,member,depth) AS (
    ${seed}
    UNION ALL
    SELECT c.task_id,json_extract(t.snapshot,'$.retryOf'),c.depth+1
    FROM chain c JOIN helper_tasks t ON t.id=c.member
    WHERE c.depth<64 AND json_extract(t.snapshot,'$.resume') IS NOT NULL
      AND json_extract(t.snapshot,'$.retryOf') IS NOT NULL
  )`;

export const stoppedHelperTasks = (tasks: string) => `${resumeChain(
  `SELECT id,id,0 FROM ${tasks} WHERE status IN ('failed','cancelled','interrupted')`
)}, stopped AS (
    SELECT t.id AS task_id,
      MAX(
        (SELECT COUNT(*) FROM helper_operations o JOIN chain m ON m.member=o.task_id
          WHERE m.task_id=t.id),
        (SELECT COALESCE(SUM(json_extract(e.data,'$.changedTargets')),0)
          FROM helper_events e JOIN chain m ON m.member=e.task_id
          WHERE m.task_id=t.id AND e.kind='operation.result')
      ) AS completed_effects,
      (json_extract(t.snapshot,'$.invalidatedBySceneDeletion') IS NULL
        AND json_extract(t.snapshot,'$.model.connection.protocol')!='codex-app-server-v1'
        AND EXISTS(SELECT 1 FROM helper_events e JOIN chain m ON m.member=e.task_id
          WHERE m.task_id=t.id AND e.kind='tool.finished'
            AND json_type(e.data,'$.callId')='text'
            AND json_type(e.data,'$.result') IS NOT NULL)) AS resumable
    FROM helper_tasks t WHERE t.id IN (SELECT task_id FROM chain)
  )`;

export type RecordedHelperExchanges = { compacted: ToolEvent[]; current: ToolEvent[] };

export function recordedHelperExchanges(
  db: DatabaseSync,
  taskId: string
): RecordedHelperExchanges | undefined {
  const compacted: ToolEvent[] = [];
  const current: ToolEvent[] = [];
  const chain = db
    .prepare(
      `WITH RECURSIVE ${resumeChain('SELECT ?,?,0')} SELECT member FROM chain ORDER BY depth DESC`
    )
    .all(taskId, taskId);
  for (const { member } of chain) {
    const calls = new Map<string, { name: string; arguments: ToolEvent['args'] }>();
    for (const row of db
      .prepare(
        `SELECT a.response FROM helper_task_attempts h JOIN attempts a ON a.id=h.attempt_id
         WHERE h.task_id=? AND h.purpose='helper' AND a.response IS NOT NULL`
      )
      .all(member)) {
      const response = JSON.parse(String(row.response)) as {
        toolCalls?: { id: string; name: string; arguments: ToolEvent['args'] }[];
      };
      for (const call of response.toolCalls ?? []) calls.set(call.id, call);
    }
    for (const row of db
      .prepare(
        "SELECT kind,data FROM helper_events WHERE task_id=? AND kind IN ('tool.finished','context.segment') ORDER BY seq"
      )
      .all(member)) {
      if (row.kind === 'context.segment') {
        compacted.push(...current.splice(0));
        continue;
      }
      const data = JSON.parse(String(row.data)) as Record<string, unknown>;
      if (typeof data.callId !== 'string') continue;
      const call = calls.get(data.callId);
      if (!call || !('result' in data)) return undefined;
      current.push({
        callId: data.callId,
        name: call.name,
        args: call.arguments,
        result: data.result,
        denied: data.denied === true,
        ...(data.errorKind === 'recoverable' ? { errorKind: 'recoverable' as const } : {}),
      });
    }
  }
  return compacted.length || current.length ? { compacted, current } : undefined;
}
