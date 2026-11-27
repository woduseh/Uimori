import type { FastifyInstance } from 'fastify';
import type { PromptPreset, PromptWorkspace, SavedPromptCombination } from '../core/product.js';
import { ownsPromptCombination } from '../core/prompt-combinations.js';
import { promptControls, resolveEditablePromptValues } from '../core/risu-prompt.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';
import { AppError } from './app-errors.js';

export function updatePromptCombination(
  store: Store,
  getWorkspace: () => PromptWorkspace,
  id: string,
  value: unknown
) {
  const b = record(value);
  fields(b, ['expectedRevision', 'sourceRevision', 'title', 'values']);
  return store.transaction(() => {
    const saved = <T>(kind: string, savedId: string): T => {
      try {
        store.product.assertAvailable(kind, savedId);
        return store.product.get<T>(kind, savedId);
      } catch (error) {
        if (error instanceof HttpError && error.statusCode === 404)
          throw new AppError(409, 'REVISION_CONFLICT');
        throw error;
      }
    };
    const item = saved<SavedPromptCombination>('prompt-combination', id);
    if (!item.owner) throw new AppError(409, 'PROMPT_COMBINATION_OWNER_MISSING');
    const current =
      item.owner.kind === 'preset'
        ? saved<PromptPreset>('prompt-preset', item.owner.id)
        : getWorkspace()[item.role];
    if ('role' in current && current.role !== item.role)
      throw new HttpError(409, 'Prompt role mismatch');
    if (!ownsPromptCombination(item, item.owner, item.role))
      throw new HttpError(409, 'Prompt role mismatch');
    const sourceRevision = 'revision' in current ? current.revision : getWorkspace().revision;
    if (sourceRevision !== number(b.sourceRevision, 'prompt revision'))
      throw new AppError(409, 'REVISION_CONFLICT');
    return store.product.saveInTransaction(
      'prompt-combination',
      {
        title: text(b.title, 'title', 200),
        role: item.role,
        owner: item.owner,
        controls: promptControls(current.program),
        values: resolveEditablePromptValues(current.program, record(b.values)),
      },
      item.id,
      number(b.expectedRevision, 'combination revision')
    );
  });
}

export function promptCombinationRoutes(
  app: FastifyInstance,
  store: Store,
  getWorkspace: () => PromptWorkspace
) {
  app.put<{ Params: { id: string } }>('/api/prompt-combinations/:id', async (request) =>
    updatePromptCombination(store, getWorkspace, request.params.id, request.body)
  );
}
