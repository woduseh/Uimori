import type { DatabaseSync } from 'node:sqlite';

/** Replaced summaries have no archive purpose; protect only current heads and retryable captures.
 * Do not collect during an in-flight provider call that may still hold a captured reference.
 */
export function pruneContextHistory(db: DatabaseSync): void {
  for (const table of ['runs', 'context_jobs', 'helper_tasks', 'helper_artifact_jobs'])
    if (db.prepare(`SELECT 1 FROM ${table} WHERE status IN ('queued','running') LIMIT 1`).get())
      return;
  db.exec(`DELETE FROM context_checkpoints WHERE id NOT IN (SELECT checkpoint_id FROM context_heads WHERE checkpoint_id IS NOT NULL)
    AND id NOT IN (SELECT json_extract(snapshot,'$.context.checkpoint.id') FROM helper_tasks
      WHERE status!='completed' AND json_type(snapshot,'$.context.checkpoint.id')='text')
    AND id NOT IN (SELECT json_extract(snapshot,'$.contextBase.checkpoint.id') FROM runs
      WHERE status!='completed' AND json_type(snapshot,'$.contextBase.checkpoint.id')='text')
    AND id NOT IN (SELECT json_extract(snapshot,'$.contextPlan.checkpoint.id') FROM runs
      WHERE status!='completed' AND json_type(snapshot,'$.contextPlan.checkpoint.id')='text');`);
}
