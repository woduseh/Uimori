import { textTokenExcerpt } from '../core/text-tokens.js';
import { uncertainAttemptResult } from './usage-accounting.js';
import { modelRequestFields } from '../core/model-request-fields.js';
import { readerEndpoints } from '#contracts';
import { readerOperations } from '#contracts/operations';
import type { FastifyInstance } from 'fastify';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { modelTimeoutMs, workspaceModelRef } from '../core/product.js';
import { generationFromModel } from '../core/model-capabilities.js';
import { contextBudgetForModel } from '../core/context-budget.js';
import {
  inputTranslationContract,
  inputTranslationLanguage,
  inputTranslationTerms,
  INPUT_TRANSLATION_CONTEXT_TOKENS,
  type InputTranslationResult,
} from '../core/input-translation.js';
import {
  executeProvider,
  ProviderContractError,
  transportConnection,
  type ProviderExecutionOptions,
  type ProviderRequest,
} from '../core/transport.js';
import { currentBotTranslationGuide } from './translation-guide.js';
import { promptWorkspace } from './prompt-workspace.js';
import { AppError } from './app-errors.js';
import { registerEndpoint } from './endpoint.js';
import { HttpError } from './request-validation.js';
import type { Store } from './store.js';

type Options = Pick<
  ProviderExecutionOptions,
  'resolveCredential' | 'executeCodex' | 'vertexRequestTier'
> & { signal: AbortSignal; track: (work: Promise<void>) => void };

export function inputTranslationRoutes(app: FastifyInstance, store: Store, options: Options) {
  registerEndpoint(
    app,
    readerEndpoints.translateInput,
    readerOperations.translateInput,
    async (
      { chatId, text: draft, targetLanguage },
      _request,
      reply
    ): Promise<InputTranslationResult> => {
      const language = inputTranslationLanguage(targetLanguage)!;
      const chat = store.chat(chatId);
      const selected = workspaceModelRef(promptWorkspace(store), 'translation');
      if (!selected) throw new AppError(409, 'MODEL_REQUIRED', { role: 'translation' });
      const model = store.product.modelSnapshot(selected.id, 'translation');
      const guide = currentBotTranslationGuide(store, chatId);
      const source = chat.headRevision ? store.source(chat.headRevision) : undefined;
      const excerpt = source
        ? textTokenExcerpt(source.text, INPUT_TRANSLATION_CONTEXT_TOKENS, { side: 'end' })
        : undefined;
      const input: ProviderRequest = {
        role: 'translation',
        ...modelRequestFields(model),
        generation: generationFromModel(model),
        contextBudget: contextBudgetForModel(model),
        stable: { contract: inputTranslationContract(language.code), tools: [] },
        input: {
          task: JSON.stringify({
            draft,
            targetLanguage: language.name,
            terms: inputTranslationTerms(draft, guide?.terms ?? []),
            context: source
              ? {
                  sourceId: source.id,
                  excerpt: excerpt!.text,
                  truncated: excerpt!.truncated,
                }
              : null,
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
        if (signal.aborted) throw new AppError(408, 'INPUT_TRANSLATION_CANCELLED');
        store.product.authorize(model.connection);
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
              attemptId = store.product.startAttempt(chatId, null, null, wire, {
                kind: 'input-translation',
                retainContent: false,
              });
            },
          });
          if (attemptId) store.product.finishAttempt(attemptId, result);
          finished = true;
          if (timeout.aborted) throw new AppError(504, 'INPUT_TRANSLATION_TIMEOUT');
          authorize();
          if (result.status === 'refused' || result.refusal)
            throw new AppError(422, 'INPUT_TRANSLATION_REFUSED');
          if (result.status !== 'completed' || result.toolCalls.length || !result.text.trim())
            throw new AppError(502, 'INPUT_TRANSLATION_FAILED');
          if (result.text.length > REQUEST_TEXT_MAX_CHARS)
            throw new AppError(422, 'INPUT_TRANSLATION_TOO_LONG', {
              limit: REQUEST_TEXT_MAX_CHARS,
            });
          return { text: result.text, targetLanguage: language.code };
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
        if (error instanceof HttpError) throw error;
        if (error instanceof ProviderContractError)
          throw new AppError(502, 'INPUT_TRANSLATION_FAILED');
        throw error;
      } finally {
        reply.raw.off('close', onClose);
      }
    }
  );
}
