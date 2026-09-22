import { pruneContextHistory } from './context-retention.js';
import type { DatabaseSync } from 'node:sqlite';

/** Keep billing and error summaries, not a second copy of every model conversation. */
function releaseAttemptBodies(db: DatabaseSync, scope: 'run' | 'job' | 'helper', id: string): void {
  const predicate =
    scope === 'helper'
      ? 'id IN (SELECT attempt_id FROM helper_task_attempts WHERE task_id=?)'
      : scope === 'run'
        ? 'run_id=?'
        : 'job_id=?';
  db.prepare(`UPDATE attempts SET
    request=json_object('protocol',json_extract(request,'$.protocol'),
      'role',role,'modelId',model_id,'pricingSnapshot',json_extract(request,'$.pricingSnapshot'),
      'pricingStartedAt',json_extract(request,'$.pricingStartedAt'),'detailsOmitted',json('true')),
    response=CASE WHEN response IS NULL THEN NULL ELSE json_object(
      'status',status,'error',json_extract(response,'$.error'),
      'usage',json_extract(response,'$.usage'),'estimatedCost',json_extract(response,'$.estimatedCost'),
      'detailsOmitted',json('true')) END
    WHERE ${predicate} AND status!='running'`).run(id);
}

export function releaseCompletedRunInputs(db: DatabaseSync, runId: string): void {
  db.prepare('DELETE FROM model_inputs WHERE run_id=?').run(runId);
  db.prepare('DELETE FROM tool_events WHERE run_id=?').run(runId);
  releaseAttemptBodies(db, 'run', runId);
  pruneContextHistory(db);
}

/** Retain image catalogs/targets and translation settings used by display and dependent jobs. */
export function releaseCompletedJobInputs(db: DatabaseSync, jobId: string): void {
  db.prepare(`UPDATE jobs SET input=json_remove(input,'$.initial','$.inputs','$.toolEvents',
    '$.failureDiagnostic','$.judgmentRecovery') WHERE id=? AND status='completed' AND json_valid(input)`).run(
    jobId
  );
  releaseAttemptBodies(db, 'job', jobId);
}

/** Successful helper conversation text is in helper_messages; failed requests keep retry inputs. */
export function releaseCompletedHelperInputs(db: DatabaseSync, taskId: string): void {
  db.prepare(`UPDATE helper_tasks SET snapshot=json_set(json_remove(snapshot,
    '$.writing','$.editor','$.selection','$.contextModel'),'$.history',json('[]'))
    WHERE id=? AND status='completed'`).run(taskId);
  db.prepare(`UPDATE helper_events SET data=json_object('name',json_extract(data,'$.name'),
    'denied',json(CASE WHEN json_extract(data,'$.denied') THEN 'true' ELSE 'false' END),'errorKind',json_extract(data,'$.errorKind'),'detailsOmitted',json('true'))
    WHERE task_id=? AND kind='tool.finished'`).run(taskId);
  db.prepare(`UPDATE helper_operations SET result=json_object('detailsOmitted',json('true'))
    WHERE task_id=? AND json_type(result,'$.artifactRef') IS NULL`).run(taskId);
  db.prepare(
    "UPDATE helper_artifact_jobs SET snapshot='{}' WHERE task_id=? AND status='completed'"
  ).run(taskId);
  releaseAttemptBodies(db, 'helper', taskId);
  pruneContextHistory(db);
}
