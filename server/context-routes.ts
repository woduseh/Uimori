import type { FastifyInstance } from 'fastify';
import type { RunSnapshot } from '../core/types.js';
import type { ContextJob } from './context-store.js';
import { HttpError, record } from './request-validation.js';
import type { Store } from './store.js';

export type ContextRouteHooks = {
  signal: AbortSignal;
  track: (work: Promise<void>) => void;
  snapshot: (chatId: string, branchId?: string) => RunSnapshot;
  execute: (job: ContextJob, signal: AbortSignal) => Promise<RunSnapshot>;
};
/** Standalone user operations; provider execution is injected by the application owner. */
export function contextRoutes(app: FastifyInstance, store: Store, hooks: ContextRouteHooks) {
  const active = new Map<string, AbortController>();
  store.context.recover();
  const publicJob = ({ snapshot: _snapshot, ...job }: ContextJob) => job;
  const detail = (chatId: string, branchId?: string) => {
    const value = store.context.detail(chatId, branchId);
    return { ...value, jobs: value.jobs.map(publicJob) };
  };
  app.get<{ Params: { id: string }; Querystring: { branchId?: string } }>(
    '/api/chats/:id/context',
    async (request) => detail(request.params.id, request.query.branchId)
  );
  app.put<{ Params: { id: string } }>('/api/chats/:id/context/summary', async (request) => {
    const body = record(request.body),
      snapshot = hooks.snapshot(request.params.id, body.branchId);
    const value = store.context.edit(request.params.id, body, snapshot);
    return { ...value, jobs: value.jobs.map(publicJob) };
  });
  app.post<{ Params: { id: string } }>('/api/chats/:id/context/compact', async (request) => {
    const body = record(request.body),
      job = store.context.schedule(
        request.params.id,
        body,
        hooks.snapshot(request.params.id, body.branchId)
      );
    if (job.status === 'queued' && !active.has(job.id) && !hooks.signal.aborted) {
      const controller = new AbortController();
      active.set(job.id, controller);
      hooks.track(
        (async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (hooks.signal.aborted || !store.context.start(job.id)) return;
          try {
            const snapshot = await hooks.execute(
              store.context.job(job.id),
              AbortSignal.any([controller.signal, hooks.signal])
            );
            store.context.finish(job.id, snapshot);
          } catch (error) {
            store.context.fail(
              job.id,
              error instanceof Error ? error.message : 'CONTEXT_COMPACTION_FAILED'
            );
          }
        })().finally(() => active.delete(job.id))
      );
    }
    return publicJob(job);
  });
  app.get<{ Params: { id: string; jobId: string } }>(
    '/api/chats/:id/context/jobs/:jobId',
    async (request) => {
      const job = store.context.job(request.params.jobId);
      if (job.chatId !== request.params.id) throw new HttpError(404, 'Context job not found');
      return publicJob(job);
    }
  );
  app.post<{ Params: { id: string; jobId: string } }>(
    '/api/chats/:id/context/jobs/:jobId/cancel',
    async (request) => {
      const job = store.context.cancel(request.params.id, request.params.jobId);
      active.get(job.id)?.abort();
      return publicJob(job);
    }
  );
  app.post<{ Params: { id: string } }>('/api/chats/:id/notes', async (request) =>
    store.story.notes.write(request.params.id, request.body)
  );
  app.addHook('preClose', async () => {
    for (const controller of active.values()) controller.abort();
  });
}
