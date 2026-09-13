import { fields, number, record, text } from './request-validation.js';
import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import {
  behaviorDetail,
  performBehaviorAction,
  performBehaviorActionWithProgram,
} from './package-behavior-host.js';
import type { BehaviorActionCommand } from './package-behavior-store.js';
import { cancelPackageRequest } from './package-requests.js';
import { skipAutomaticRunBehavior } from './package-behavior-run.js';
import { skipAfterResponse } from './package-after-response.js';

export function packageBehaviorRoutes(
  app: FastifyInstance,
  store: Store,
  publish?: (chatId: string) => void
) {
  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/skip-package-after-response',
    async (request) => {
      const result = skipAfterResponse(store, request.params.id, request.body);
      publish?.(store.run(request.params.id).chatId);
      return {
        skipped: result.skipped,
        afterResponse: {
          status: result.afterResponse.status,
          completed: result.afterResponse.completed,
          total: result.afterResponse.total,
        },
      };
    }
  );
  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/skip-package-preparation',
    async (request) => {
      const result = skipAutomaticRunBehavior(store, request.params.id, request.body);
      publish?.(store.run(request.params.id).chatId);
      return result;
    }
  );
  app.delete<{ Params: { id: string; requestId: string } }>(
    '/api/chats/:id/package-requests/:requestId',
    async (request) => {
      const body = record(request.body);
      fields(body, ['branchId']);
      return cancelPackageRequest(
        store,
        request.params.id,
        body.branchId === undefined ? undefined : text(body.branchId, 'branch ID', 200),
        request.params.requestId
      );
    }
  );
  app.get<{ Params: { id: string }; Querystring: { branchId?: string } }>(
    '/api/chats/:id/package-behaviors',
    async (request) => behaviorDetail(store, request.params.id, request.query.branchId)
  );
  for (const reset of [false, true])
    app.post<{ Params: { id: string; instanceId: string } }>(
      `/api/chats/:id/package-behaviors/:instanceId/${reset ? 'reset' : 'actions'}`,
      async (request, reply) => {
        const b = record(request.body);
        fields(b, [
          'branchId',
          'expectedStateRevision',
          'expectedSourceHash',
          'idempotencyKey',
          ...(reset ? [] : ['actionId', 'input', 'panelId', 'expectedPackageRevision']),
        ]);
        const command = {
          expectedStateRevision: number(b.expectedStateRevision, 'state revision', 0),
          expectedSourceHash:
            b.expectedSourceHash === null ? null : text(b.expectedSourceHash, 'source hash', 200),
          idempotencyKey: text(b.idempotencyKey, 'idempotency key', 200),
          ...(!reset ? { actionId: text(b.actionId, 'action ID', 100), input: b.input } : {}),
        };
        const branchId = b.branchId === undefined ? undefined : text(b.branchId, 'branch ID', 200);
        const panel =
          b.panelId === undefined && b.expectedPackageRevision === undefined
            ? undefined
            : {
                id: text(b.panelId, 'panel ID', 64),
                packageRevision: number(b.expectedPackageRevision, 'package revision', 1),
              };
        if (reset)
          return performBehaviorAction(
            store,
            request.params.id,
            branchId,
            request.params.instanceId,
            command,
            true
          );
        const abort = new AbortController();
        const cancel = () => {
          if (!reply.raw.writableEnded) abort.abort();
        };
        request.raw.once('aborted', cancel);
        reply.raw.once('close', cancel);
        try {
          if (request.raw.aborted) abort.abort();
          return await performBehaviorActionWithProgram(
            store,
            request.params.id,
            branchId,
            request.params.instanceId,
            command as BehaviorActionCommand,
            panel,
            abort.signal
          );
        } finally {
          request.raw.removeListener('aborted', cancel);
          reply.raw.removeListener('close', cancel);
        }
      }
    );
}
