import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import {
  REQUEST_TEXT_MAX_CHARS,
  SOURCE_TEXT_MAX_CHARS,
  TRANSLATION_TEXT_MAX_CHARS,
} from '../core/content-limits.js';
import { modelTimeoutMs, workspaceModelRef } from '../core/product.js';
import { modelRequestFields } from '../core/model-request-fields.js';
import { generationFromModel } from '../core/model-capabilities.js';
import { contextBudgetForModel } from '../core/context-budget.js';
import {
  REVISION_CONTEXTS,
  SELECTION_REVISION_CONTRACT,
  surroundingDraft,
  validRevisionRange,
  type RevisionContext,
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
import { AppError } from './app-errors.js';
import { shownTranslationChanged } from './source-editing.js';
import type { Store } from './store.js';

type Options = Pick<
  ProviderExecutionOptions,
  'resolveCredential' | 'executeCodex' | 'vertexRequestTier'
> & { signal: AbortSignal; track: (work: Promise<void>) => void };

export function selectionRevisionRoutes(app: FastifyInstance, store: Store, options: Options) {
  app.post<{ Params: { id: string } }>(
    '/api/sources/:id/selection-revision',
    { bodyLimit: 32 * 1024 * 1024 },
    async (request, reply): Promise<SelectionRevisionResult> => {
      const body = record(request.body);
      fields(body, [
        'target',
        'draft',
        'start',
        'end',
        'instruction',
        'expectedSourceHash',
        'expectedRevision',
        'expectedTextHash',
        'context',
      ]);
      if (body.target !== undefined && body.target !== 'source' && body.target !== 'translation')
        throw new HttpError(400, 'Invalid revision target');
      const context = (body.context ?? 'scene') as RevisionContext;
      if (!REVISION_CONTEXTS.includes(context))
        throw new HttpError(400, 'Invalid revision context');
      const translation = body.target === 'translation';
      const limit = translation ? TRANSLATION_TEXT_MAX_CHARS : SOURCE_TEXT_MAX_CHARS;
      const draft = text(body.draft, 'revision draft', limit);
      const instruction = text(body.instruction, 'revision instruction', REQUEST_TEXT_MAX_CHARS);
      const start = number(body.start, 'selection start', 0, draft.length);
      const end = number(body.end, 'selection end', 1, draft.length);
      if (!validRevisionRange(draft, start, end))
        throw new HttpError(400, 'SELECTION_REVISION_RANGE_INVALID');
      const expectedHash = text(body.expectedSourceHash, 'source hash', 64);
      const expectedRevision = number(body.expectedRevision, 'source revision', 0);
      const expectedTextHash = translation
        ? text(body.expectedTextHash, 'translation hash', 64)
        : undefined;
      if (
        expectedTextHash !== undefined &&
        createHash('sha256').update(draft).digest('hex') !== expectedTextHash
      )
        throw new HttpError(409, 'SELECTION_REVISION_TRANSLATION_STALE');
      const source = store.source(request.params.id);
      const checkSource = () => {
        const current = store.source(source.id);
        if (
          current.hash !== expectedHash ||
          (!translation && (current.editRevision ?? 0) !== expectedRevision)
        )
          throw new HttpError(409, 'SELECTION_REVISION_STALE');
        if (
          translation &&
          shownTranslationChanged(store, source.id, {
            sourceHash: expectedHash,
            revision: expectedRevision,
            textHash: expectedTextHash,
          })
        )
          throw new HttpError(409, 'SELECTION_REVISION_TRANSLATION_STALE');
      };
      checkSource();
      const selected = workspaceModelRef(promptWorkspace(store), 'helper');
      if (!selected) throw new AppError(409, 'MODEL_REQUIRED', { role: 'helper' });
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
            surroundingDraft: surroundingDraft(draft, start, end, context),
          }),
          controls: {},
        },
      };
      const disconnected = new AbortController();
      const onClose = () => {
        if (!reply.raw.writableEnded) disconnected.abort();
      };
      reply.raw.on('close', onClose);
      const timeoutMs = modelTimeoutMs(model);
      const timeout = AbortSignal.timeout(timeoutMs);
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
            timeoutMs,
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
          if (draft.length - (end - start) + result.text.length > limit)
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
