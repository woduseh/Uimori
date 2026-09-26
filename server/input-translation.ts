import type { FastifyInstance } from 'fastify';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { workspaceModelRef } from '../core/product.js';
import { generationFromModel } from '../core/model-capabilities.js';
import { contextBudgetForModel } from '../core/context-budget.js';
import {
  inputTranslationContract,
  inputTranslationLanguage,
  inputTranslationTerms,
  INPUT_TRANSLATION_CONTEXT_LENGTH,
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
import { HttpError, fields, record, text } from './request-validation.js';
import type { Store } from './store.js';

const TIMEOUT_MS = 120_000;
type Options = Pick<
  ProviderExecutionOptions,
  'resolveCredential' | 'executeCodex' | 'vertexRequestTier'
> & { signal: AbortSignal; track: (work: Promise<void>) => void };

/** One explicit, cancellable call. No fake source, job, agent, draft journal or story mutation. */
export function inputTranslationRoutes(app: FastifyInstance, store: Store, options: Options) {
  app.post<{ Params: { id: string } }>(
    '/api/chats/:id/input-translation',
    { bodyLimit: 16 * 1024 * 1024 },
    async (request, reply): Promise<InputTranslationResult> => {
      const body = record(request.body);
      fields(body, ['text', 'targetLanguage', 'branchId']);
      const draft = text(body.text, 'input translation text', REQUEST_TEXT_MAX_CHARS);
      const language = inputTranslationLanguage(body.targetLanguage);
      if (!language) throw new HttpError(400, 'INPUT_TRANSLATION_LANGUAGE_INVALID');
      const chatId = request.params.id;
      store.chat(chatId);
      const branch = store.product.branch(
        chatId,
        body.branchId === undefined ? undefined : text(body.branchId, 'branchId', 200)
      );
      const selected = workspaceModelRef(promptWorkspace(store), 'translation');
      if (!selected) throw new HttpError(409, 'MODEL_REQUIRED:translation');
      const model = store.product.modelSnapshot(selected.id, 'translation');
      const guide = currentBotTranslationGuide(store, chatId);
      const source = branch.headRevision ? store.source(branch.headRevision) : undefined;
      const input: ProviderRequest = {
        role: 'translation',
        modelId: model.modelId,
        pricingSnapshot: model.pricingSnapshot,
        generation: generationFromModel(model),
        contextBudget: contextBudgetForModel(model),
        ...(model.providerOptions !== undefined
          ? { providerOptions: structuredClone(model.providerOptions) }
          : {}),
        stable: { contract: inputTranslationContract(language.code), tools: [] },
        input: {
          task: JSON.stringify({
            draft,
            targetLanguage: language.name,
            terms: inputTranslationTerms(draft, guide?.terms ?? []),
            context: source
              ? {
                  sourceId: source.id,
                  excerpt: source.text.slice(-INPUT_TRANSLATION_CONTEXT_LENGTH),
                  truncated: source.text.length > INPUT_TRANSLATION_CONTEXT_LENGTH,
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
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const signal = AbortSignal.any([options.signal, disconnected.signal, timeout]);
      const authorize = () => {
        if (signal.aborted) throw new HttpError(408, 'INPUT_TRANSLATION_CANCELLED');
        store.product.authorize(model.connection);
      };
      const work = (async () => {
        authorize();
        const result = await executeProvider(transportConnection(model.connection), input, {
          ...options,
          signal,
          timeoutMs: TIMEOUT_MS,
          beforeTurn: authorize,
          onWire: authorize,
        });
        if (timeout.aborted) throw new HttpError(504, 'INPUT_TRANSLATION_TIMEOUT');
        authorize();
        if (result.status === 'refused' || result.refusal)
          throw new HttpError(422, 'INPUT_TRANSLATION_REFUSED');
        if (result.status !== 'completed' || result.toolCalls.length || !result.text.trim())
          throw new HttpError(502, 'INPUT_TRANSLATION_FAILED');
        if (result.text.length > REQUEST_TEXT_MAX_CHARS)
          throw new HttpError(422, 'INPUT_TRANSLATION_TOO_LONG');
        return { text: result.text, targetLanguage: language.code };
      })();
      // Integrate shutdown/maintenance accounting without persisting either version of the draft.
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
        if (error instanceof HttpError) throw error;
        if (error instanceof ProviderContractError)
          throw new HttpError(502, 'INPUT_TRANSLATION_FAILED');
        throw error;
      } finally {
        reply.raw.off('close', onClose);
      }
    }
  );
}
