import type { DatabaseSync } from 'node:sqlite';

/** Completed prose is the durable result; historical provider packets are not a second manuscript. */
export function releaseCompletedRunInputs(db: DatabaseSync, runId: string): void {
  db.prepare('DELETE FROM model_inputs WHERE run_id=?').run(runId);
  db.prepare('DELETE FROM tool_events WHERE run_id=?').run(runId);
  db.prepare(`UPDATE attempts SET
      request=json_object('protocol',json_extract(request,'$.protocol'),
        'role',role,'modelId',model_id,'pricingSnapshot',json_extract(request,'$.pricingSnapshot'),
        'pricingStartedAt',json_extract(request,'$.pricingStartedAt'),'detailsOmitted',json('true')),
      response=CASE WHEN response IS NULL THEN NULL ELSE json_object(
        'status',status,'error',json_extract(response,'$.error'),
        'usage',json_extract(response,'$.usage'),'estimatedCost',json_extract(response,'$.estimatedCost'),
        'detailsOmitted',json('true')) END
    WHERE run_id=? AND status!='running'`).run(runId);
}
