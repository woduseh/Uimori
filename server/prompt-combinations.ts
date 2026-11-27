import type { FastifyInstance } from 'fastify';
import type { PromptPreset, PromptWorkspace, SavedPromptCombination } from '../core/product.js';
import { ownsPromptCombination } from '../core/prompt-combinations.js';
import { promptControls, resolveEditablePromptValues } from '../core/risu-prompt.js';
import { promptEndpoints, type UpdatePromptCombination } from '#contracts';
import { promptOperations } from '#contracts/operations';
import { HttpError } from './request-validation.js';
import { registerEndpoint } from './endpoint.js';
import type { Store } from './store.js';
import { AppError, assertRevision } from './app-errors.js';

export function updatePromptCombination(
  store: Store,
  getWorkspace: () => PromptWorkspace,
  { id, expectedRevision, sourceRevision: expectedSource, title, values }: UpdatePromptCombination
) {
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
    const current =
      item.owner.kind === 'preset'
        ? saved<PromptPreset>('prompt-preset', item.owner.id)
        : getWorkspace()[item.role];
    if ('role' in current && current.role !== item.role)
      throw new HttpError(409, 'Prompt role mismatch');
    if (!ownsPromptCombination(item, item.owner, item.role))
      throw new HttpError(409, 'Prompt role mismatch');
    assertRevision(
      'revision' in current ? current.revision : getWorkspace().revision,
      expectedSource
    );
    return store.product.saveInTransaction(
      'prompt-combination',
      {
        title,
        role: item.role,
        owner: item.owner,
        controls: promptControls(current.program),
        values: resolveEditablePromptValues(
          current.program,
          values as SavedPromptCombination['values']
        ),
      },
      item.id,
      expectedRevision
    );
  });
}

export function promptCombinationRoutes(
  app: FastifyInstance,
  store: Store,
  getWorkspace: () => PromptWorkspace
) {
  registerEndpoint(
    app,
    promptEndpoints.updateCombination,
    promptOperations.updateCombination,
    (input) => updatePromptCombination(store, getWorkspace, input)
  );
}
