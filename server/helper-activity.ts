import type {
  HelperActivity,
  HelperActivityEvent,
  HelperProviderRetry,
  HelperActivityTarget,
  HelperActivityTargetRef,
} from '../core/helper-activity.js';
import type { HelperStatus } from '../core/helper.js';
import { HttpError } from './request-validation.js';
import type { Store } from './store.js';
import { sceneTitle } from './scene-titles.js';

function resolveTarget(store: Store, value: unknown): HelperActivityTarget | undefined {
  if (typeof value !== 'string') return undefined;
  const ref = JSON.parse(value) as HelperActivityTargetRef;
  if ('count' in ref) return Number.isSafeInteger(ref.count) ? { count: ref.count } : undefined;
  if (typeof ref.kind !== 'string' || typeof ref.id !== 'string') return undefined;
  if (ref.kind === 'scene') {
    if (!store.db.prepare('SELECT 1 FROM sources WHERE id=?').get(ref.id)) return undefined;
    const title = sceneTitle(store, ref.id);
    return title ? { kind: 'scene', title } : { kind: 'scene' };
  }
  const row = store.db
    .prepare(
      `SELECT json_extract(body,'$.title') AS title FROM versions v WHERE kind=? AND id=?
       AND NOT EXISTS(SELECT 1 FROM library_hidden h WHERE h.kind=v.kind AND h.id=v.id)`
    )
    .get(ref.kind, ref.id);
  return typeof row?.title === 'string' ? { kind: ref.kind, title: row.title } : undefined;
}

const activityLimit = 80;

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
          json_extract(data,'$.errorCode'),
          json_extract(data,'$.errorKind')
        ),1,500) AS error,
        substr(json_extract(data,'$.text'),1,1000) AS text,
        length(json_extract(data,'$.text'))>1000 AS text_truncated,
        json_extract(data,'$.applied') AS applied,
        json_extract(data,'$.callId') AS call_id,
        CASE WHEN kind='tool.started' THEN json_extract(data,'$.target') END AS target,
        CASE WHEN kind='provider.retry' THEN data END AS retry
       FROM helper_events WHERE conversation_id=? AND task_id=?
         AND kind IN ('attempt.started','attempt.finished','tool.started','tool.finished','progress','context.compaction','provider.retry')
       ORDER BY seq DESC LIMIT ?`
    )
    .all(task.conversation_id, taskId, activityLimit + 1);
  const string = (value: unknown) => (typeof value === 'string' ? value : undefined);
  return {
    taskId,
    status: task.status as HelperStatus,
    hasEarlier: rows.length > activityLimit,
    helperCalls: Number(
      store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM helper_events WHERE conversation_id=? AND task_id=?
           AND kind='attempt.started' AND json_extract(data,'$.purpose')='helper'`
        )
        .get(task.conversation_id, taskId)!.n
    ),
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
          callId: string(row.call_id),
          target: resolveTarget(store, row.target),
          retry:
            typeof row.retry === 'string'
              ? (JSON.parse(row.retry) as HelperProviderRetry)
              : undefined,
        })
      ),
  };
}
