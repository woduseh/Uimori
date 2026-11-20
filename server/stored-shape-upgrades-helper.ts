import type { DatabaseSync } from 'node:sqlite';

export function upgradeHelperStoredShapes(db: DatabaseSync): void {
  db.exec(`
    UPDATE helper_events SET data=json_set(data,'$.inputTokenLimit',
      (SELECT json_extract(t.snapshot,'$.model.inputTokenLimit') FROM helper_tasks t WHERE t.id=helper_events.task_id))
    WHERE kind='input.measured' AND json_valid(data) AND json_extract(data,'$.inputTokenLimit') IS NULL
      AND EXISTS (SELECT 1 FROM helper_tasks t WHERE t.id=helper_events.task_id
        AND json_valid(t.snapshot) AND json_extract(t.snapshot,'$.model.inputTokenLimit') IS NOT NULL);
    UPDATE helper_conversations SET limits=json_remove(limits,'$.artifacts')
    WHERE json_valid(limits) AND json_type(limits,'$.artifacts') IS NOT NULL;
    UPDATE helper_tasks SET snapshot=json_remove(snapshot,'$.limits.artifacts')
    WHERE json_valid(snapshot) AND json_type(snapshot,'$.limits.artifacts') IS NOT NULL;
  `);
}
