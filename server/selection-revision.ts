import { readerEndpoints, type SelectionRevisionResult } from '#contracts';
import { readerOperations } from '#contracts/operations';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { SOURCE_TEXT_MAX_CHARS, TRANSLATION_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { modelTimeoutMs, workspaceModelRef } from '../core/product.js';
import { modelRequestFields } from '../core/model-request-fields.js';
import { generationFromModel } from '../core/model-capabilities.js';
import { contextBudgetForModel } from '../core/context-budget.js';
import {
  SELECTION_REVISION_CONTRACT,
  surroundingDraft,
  validRevisionRange,
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
import { AppError } from './app-errors.js';
import { registerEndpoint } from './endpoint.js';
import { shownTranslationChanged } from './source-editing.js';
import type { Store } from './store.js';

type Options = Pick<
  ProviderExecutionOptions,
  'resolveCredential' | 'executeCodex' | 'vertexRequestTier'
> & { signal: AbortSignal; track: (work: Promise<void>) => void };

export function selectionRevisionRoutes(app: FastifyInstance, store: Store, options: Options) {
  registerEndpoint(
    app,
    readerEndpoints.reviseSelection,
    readerOperations.reviseSelection,
    async (body, _request, reply): Promise<SelectionRevisionResult> => {
      const { draft, start, end, instruction, expectedSourceHash: expectedHash } = body;
      const translation = body.target === 'translation';
      const limit = translation ? TRANSLATION_TEXT_MAX_CHARS : SOURCE_TEXT_MAX_CHARS;
      const expectedRevision = body.expectedRevision;
      const expectedTextHash = body.target === 'translation' ? body.expectedTextHash : undefined;
      if (
        expectedTextHash !== undefined &&
        createHash('sha256').update(draft).digest('hex') !== expectedTextHash
      )
        throw new AppError(409, 'SELECTION_REVISION_TRANSLATION_STALE');
      const source = store.writableSource(body.sourceId);
      const checkSource = () => {
        const current = store.writableSource(source.id);
        if (
          current.hash !== expectedHash ||
          (!translation && (current.editRevision ?? 0) !== expectedRevision)
        )
          throw new AppError(409, 'SELECTION_REVISION_STALE');
        if (
          translation &&
          shownTranslationChanged(store, source.id, {
            sourceHash: expectedHash,
            revision: expectedRevision,
            textHash: expectedTextHash,
          })
        )
          throw new AppError(409, 'SELECTION_REVISION_TRANSLATION_STALE');
      };
      checkSource();
      if (!validRevisionRange(draft, start, end))
        throw new AppError(400, 'SELECTION_REVISION_RANGE_INVALID');
      const context = body.context ?? 'scene';
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
        if (timeout.aborted) throw new AppError(504, 'SELECTION_REVISION_TIMEOUT');
        if (signal.aborted) throw new AppError(408, 'SELECTION_REVISION_CANCELLED');
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
            throw new AppError(422, 'SELECTION_REVISION_REFUSED');
          if (result.status !== 'completed' || result.toolCalls.length || !result.text.trim())
            throw new AppError(502, 'SELECTION_REVISION_FAILED');
          if (draft.length - (end - start) + result.text.length > limit)
            throw new AppError(422, 'SELECTION_REVISION_TOO_LONG');
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
        return await work;
      } catch (error) {
        if (error instanceof ProviderContractError)
          throw new AppError(502, 'SELECTION_REVISION_FAILED');
        throw error;
      } finally {
        reply.raw.off('close', onClose);
      }
    }
  );
}
