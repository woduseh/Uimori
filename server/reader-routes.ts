import { type ChatJob, readerEndpoints } from '#contracts';
import { readerOperations } from '#contracts/operations';
import type { FastifyInstance } from 'fastify';
import type { SceneUsageDetail } from '../core/scene-usage.js';
import { providerCacheUsage } from '../core/provider-cache-usage.js';
import { AppError } from './app-errors.js';
import { registerEndpoint } from './endpoint.js';
import { sceneRequestLore } from './request-lore.js';
import type { Store } from './store.js';
import { chatTraceCalls } from './task-trace.js';

const recordGone = () => new AppError(404, 'LIBRARY_ITEM_DELETED');

export function readerRoutes(app: FastifyInstance, store: Store) {
  registerEndpoint(
    app,
    readerEndpoints.readSceneDetail,
    readerOperations.readSceneDetail,
    ({ attemptId }) => {
      const row = store.db
        .prepare(`SELECT json_extract(request,'$.protocol') AS protocol,
      json_extract(request,'$.requestLore') AS lore,raw_usage AS rawUsage
      FROM attempts WHERE id=? AND usage_kind='writing' AND job_id IS NULL`)
        .get(attemptId) as
        | { protocol: string | null; lore: string | null; rawUsage: string | null }
        | undefined;
      if (!row) throw recordGone();
      return {
        cache:
          providerCacheUsage(row.protocol, row.rawUsage ? JSON.parse(row.rawUsage) : null) ?? null,
        lore: row.lore ? JSON.parse(row.lore) : null,
      } satisfies SceneUsageDetail;
    }
  );
  registerEndpoint(
    app,
    readerEndpoints.readLastSceneLore,
    readerOperations.readLastSceneLore,
    ({ chatId }) => {
      const chat = store.chat(chatId);
      return {
        sourceRevision: chat.headRevision,
        ...(chat.headRevision
          ? sceneRequestLore(store, chat.headRevision)
          : { attemptId: null, lore: null }),
      };
    }
  );
  registerEndpoint(
    app,
    readerEndpoints.listChatAttempts,
    readerOperations.listChatAttempts,
    ({ chatId }) => chatTraceCalls(store, chatId)
  );
  registerEndpoint(
    app,
    readerEndpoints.readAttempt,
    readerOperations.readAttempt,
    ({ attemptId }) => {
      const row = store.db
        .prepare(
          `SELECT id,run_id AS runId,job_id AS jobId,role,connection_id AS connectionId,model_id AS modelId,status,input_tokens AS inputTokens,output_tokens AS outputTokens,cost_usd AS costUsd,price_revision AS priceRevision,error,request,response,raw_usage AS rawUsage FROM attempts WHERE id=?`
        )
        .get(attemptId) as (Record<string, unknown> & { id: string }) | undefined;
      if (!row) throw recordGone();
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
    }
  );
  registerEndpoint(
    app,
    readerEndpoints.listChatJobs,
    readerOperations.listChatJobs,
    ({ chatId }) => {
      store.chat(chatId);
      return store.db
        .prepare(
          `SELECT j.id,j.source_revision AS sourceRevision,j.kind,j.status,j.error,j.generation AS attempt FROM jobs j JOIN sources s ON s.id=j.source_revision WHERE j.chat_id=? AND j.kind!='status' AND j.source_hash=COALESCE((SELECT hash FROM source_edits WHERE source_id=s.id ORDER BY revision DESC LIMIT 1),s.hash) AND (j.kind!='translation' OR j.id=(SELECT id FROM jobs WHERE source_revision=s.id AND kind='translation' ORDER BY revision DESC,created_at DESC,id DESC LIMIT 1)) ORDER BY j.created_at,j.id`
        )
        .all(chatId) as ChatJob[];
    }
  );
  registerEndpoint(app, readerEndpoints.readJob, readerOperations.readJob, ({ jobId }) => {
    if (!store.db.prepare('SELECT 1 FROM jobs WHERE id=?').get(jobId)) throw recordGone();
    return store.job(jobId);
  });
}
