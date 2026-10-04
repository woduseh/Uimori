import type { HelperActivity, HelperActivityEvent } from '../core/helper-activity.js';
import type { HelperStatus } from '../core/helper.js';
import { HttpError } from './request-validation.js';
import type { Store } from './store.js';

const activityLimit = 80;

/** Read only bounded diagnostic fields, without hydrating task snapshots or tool results. */
export function readHelperActivity(store: Store, taskId: string): HelperActivity {
  const task = store.db
    .prepare('SELECT conversation_id,status FROM helper_tasks WHERE id=?')
    .get(taskId);
  if (!task) throw new HttpError(404, '도우미 작업을 찾을 수 없어요.');
  const rows = store.db
    .prepare(
      `SELECT seq,kind,
        json_extract(data,'$.id') AS attempt_id,
        json_extract(data,'$.purpose') AS purpose,
        json_extract(data,'$.name') AS name,
        json_extract(data,'$.status') AS status,
        json_extract(data,'$.denied') AS denied,
        substr(COALESCE(
          CASE WHEN json_type(data,'$.result.error')='text' THEN json_extract(data,'$.result.error') END,
          json_extract(data,'$.result.error.code'),json_extract(data,'$.result.code'),
          json_extract(data,'$.errorKind')
        ),1,500) AS error,
        substr(json_extract(data,'$.text'),1,1000) AS text,
        length(json_extract(data,'$.text'))>1000 AS text_truncated,
        json_extract(data,'$.applied') AS applied
       FROM helper_events WHERE conversation_id=? AND task_id=?
         AND kind IN ('attempt.started','attempt.finished','tool.finished','progress','context.compaction')
       ORDER BY seq DESC LIMIT ?`
    )
    .all(task.conversation_id, taskId, activityLimit + 1);
  const string = (value: unknown) => (typeof value === 'string' ? value : undefined);
  return {
    taskId,
    status: task.status as HelperStatus,
    hasEarlier: rows.length > activityLimit,
    events: rows
      .slice(0, activityLimit)
      .reverse()
      .map(
        (row): HelperActivityEvent => ({
          seq: Number(row.seq),
          kind: String(row.kind),
          attemptId: string(row.attempt_id),
          purpose: string(row.purpose),
          name: string(row.name),
          status: string(row.status),
          denied: row.denied == null ? undefined : Boolean(row.denied),
          error: string(row.error),
          text: string(row.text),
          textTruncated: row.text_truncated ? true : undefined,
          applied: row.applied == null ? undefined : Boolean(row.applied),
        })
      ),
  };
}
