import type { FastifyInstance } from 'fastify';
import { REQUEST_TEXT_MAX_CHARS, SOURCE_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { workspaceModelRef } from '../core/product.js';
import { modelRequestFields } from '../core/model-request-fields.js';
import { generationFromModel } from '../core/model-capabilities.js';
import { contextBudgetForModel } from '../core/context-budget.js';
import {
  SELECTION_REVISION_CONTRACT,
  validRevisionRange,
  type SelectionRevisionResult,
} from '../core/selection-revision.js';
import {
  executeProvider,
  ProviderContractError,
  transportConnection,
  type ProviderExecutionOptions,
  type ProviderRequest,
} from '../core/transport.js';
import { uncertainAttemptResult } from './usage-accounting.js';
import { promptWorkspace } from './prompt-workspace.js';
import { HttpError, fields, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

const TIMEOUT_MS = 120_000;
type Options = Pick<
  ProviderExecutionOptions,
  'resolveCredential' | 'executeCodex' | 'vertexRequestTier'
> & { signal: AbortSignal; track: (work: Promise<void>) => void };

/** One proposal call: the browser owns the draft and existing source saving owns the write. */
export function selectionRevisionRoutes(app: FastifyInstance, store: Store, options: Options) {
  app.post<{ Params: { id: string } }>(
    '/api/sources/:id/selection-revision',
    { bodyLimit: 32 * 1024 * 1024 },
    async (request, reply): Promise<SelectionRevisionResult> => {
      const body = record(request.body);
      fields(body, [
        'draft',
        'start',
        'end',
        'instruction',
        'expectedSourceHash',
        'expectedRevision',
      ]);
      const draft = text(body.draft, 'revision draft', SOURCE_TEXT_MAX_CHARS);
      const instruction = text(body.instruction, 'revision instruction', REQUEST_TEXT_MAX_CHARS);
      const start = number(body.start, 'selection start', 0, draft.length);
      const end = number(body.end, 'selection end', 1, draft.length);
      if (!validRevisionRange(draft, start, end))
        throw new HttpError(400, 'SELECTION_REVISION_RANGE_INVALID');
      const expectedHash = text(body.expectedSourceHash, 'source hash', 64);
      const expectedRevision = number(body.expectedRevision, 'source revision', 0);
      const source = store.source(request.params.id);
      const checkSource = () => {
        const current = store.source(source.id);
        if (current.hash !== expectedHash || (current.editRevision ?? 0) !== expectedRevision)
          throw new HttpError(409, 'SELECTION_REVISION_STALE');
      };
      checkSource();
      const selected = workspaceModelRef(promptWorkspace(store), 'helper');
      if (!selected) throw new HttpError(409, 'MODEL_REQUIRED:helper');
      const model = store.product.modelSnapshot(selected.id, 'helper');
      const input: ProviderRequest = {
        role: 'helper',
        ...modelRequestFields(model),
        generation: generationFromModel(model),
        contextBudget: contextBudgetForModel(model),
        stable: { contract: SELECTION_REVISION_CONTRACT, tools: [] },
        input: {
          task: JSON.stringify({
            revisionInstruction: instruction,
            selectedPassage: draft.slice(start, end),
            surroundingDraft: { before: draft.slice(0, start), after: draft.slice(end) },
          }),
          controls: {},
        },
      };
      const disconnected = new AbortController();
      const onClose = () => {
        if (!reply.raw.writableEnded) disconnected.abort();
      };
      reply.raw.on('close', onClose);
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const signal = AbortSignal.any([options.signal, disconnected.signal, timeout]);
      const authorize = () => {
        if (timeout.aborted) throw new HttpError(504, 'SELECTION_REVISION_TIMEOUT');
        if (signal.aborted) throw new HttpError(408, 'SELECTION_REVISION_CANCELLED');
        store.product.authorize(model.connection);
        checkSource();
      };
      const work = (async () => {
        let attemptId: string | undefined;
        let finished = false;
        try {
          authorize();
          const result = await executeProvider(transportConnection(model.connection), input, {
            ...options,
            signal,
            timeoutMs: TIMEOUT_MS,
            beforeTurn: authorize,
            onWire: (wire) => {
              authorize();
              attemptId = store.product.startAttempt(source.chatId, null, null, wire, {
                kind: 'helper',
                retainContent: false,
              });
            },
          });
          if (attemptId) store.product.finishAttempt(attemptId, result);
          finished = true;
          authorize();
          if (result.status === 'refused' || result.refusal)
            throw new HttpError(422, 'SELECTION_REVISION_REFUSED');
          if (result.status !== 'completed' || result.toolCalls.length || !result.text.trim())
            throw new HttpError(502, 'SELECTION_REVISION_FAILED');
          if (draft.length - (end - start) + result.text.length > SOURCE_TEXT_MAX_CHARS)
            throw new HttpError(422, 'SELECTION_REVISION_TOO_LONG');
          return { text: result.text };
        } catch (error) {
          if (attemptId && !finished)
            store.product.finishAttempt(attemptId, uncertainAttemptResult(signal.aborted));
          throw error;
        }
      })();
      options.track(
        work.then(
          () => {},
          () => {}
        )
      );
      try {
        reply.header('Cache-Control', 'no-store');
        return await work;
      } catch (error) {
        if (error instanceof ProviderContractError)
          throw new HttpError(502, 'SELECTION_REVISION_FAILED');
        throw error;
      } finally {
        reply.raw.off('close', onClose);
      }
    }
  );
}
