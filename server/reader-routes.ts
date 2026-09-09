import { HttpError } from './request-validation.js';
import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';

export function readerRoutes(app: FastifyInstance, store: Store) {
  app.get<{ Params: { id: string } }>('/api/chats/:id/attempts', async (request) => {
    store.chat(request.params.id);
    const rows = store.db
      .prepare(
        `SELECT id,run_id AS runId,job_id AS jobId,story_job_id AS storyJobId,role,connection_id AS connectionId,model_id AS modelId,status,input_tokens AS inputTokens,output_tokens AS outputTokens,cost_usd AS costUsd,price_revision AS priceRevision,error,json_extract(response,'$.estimatedCost') AS estimateJson FROM attempts WHERE chat_id=? ORDER BY rowid`
      )
      .all(request.params.id);
    return rows.map(({ estimateJson, ...row }) => ({
      ...row,
      ...(typeof estimateJson === 'string' ? { estimatedCost: JSON.parse(estimateJson) } : {}),
    }));
  });
  app.get<{ Params: { id: string } }>('/api/attempts/:id', async (request) => {
    const row = store.db
      .prepare(
        `SELECT id,run_id AS runId,job_id AS jobId,story_job_id AS storyJobId,role,connection_id AS connectionId,model_id AS modelId,status,input_tokens AS inputTokens,output_tokens AS outputTokens,cost_usd AS costUsd,price_revision AS priceRevision,error,request,response,raw_usage AS rawUsage FROM attempts WHERE id=?`
      )
      .get(request.params.id) as Record<string, unknown> | undefined;
    if (!row) throw new HttpError(404, 'Attempt not found');
    return {
      ...row,
      request: row.request == null ? null : JSON.parse(String(row.request)),
      response: row.response == null ? null : JSON.parse(String(row.response)),
      rawUsage: row.rawUsage == null ? null : JSON.parse(String(row.rawUsage)),
      estimatedCost:
        row.response == null ? undefined : JSON.parse(String(row.response)).estimatedCost,
      pricingSnapshot:
        row.request == null ? undefined : JSON.parse(String(row.request)).pricingSnapshot,
      pricingStartedAt:
        row.request == null ? undefined : JSON.parse(String(row.request)).pricingStartedAt,
    };
  });
  app.get<{ Params: { id: string } }>('/api/chats/:id/jobs', async (request) => {
    store.chat(request.params.id);
    return store.db
      .prepare(
        `SELECT j.id,j.source_revision AS sourceRevision,j.kind,j.status,j.error,j.generation AS attempt FROM jobs j JOIN sources s ON s.id=j.source_revision WHERE j.chat_id=? AND j.source_hash=COALESCE((SELECT hash FROM source_edits WHERE source_id=s.id ORDER BY revision DESC LIMIT 1),s.hash) AND (j.kind!='translation' OR j.id=(SELECT id FROM jobs WHERE source_revision=s.id AND kind='translation' ORDER BY revision DESC,created_at DESC,id DESC LIMIT 1)) ORDER BY j.created_at,j.id`
      )
      .all(request.params.id);
  });
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request) =>
    store.job(request.params.id)
  );
}
