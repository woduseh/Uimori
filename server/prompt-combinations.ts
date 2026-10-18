import type { FastifyInstance } from 'fastify';
import type { PromptPreset, PromptWorkspace, SavedPromptCombination } from '../core/product.js';
import { ownsPromptCombination } from '../core/prompt-combinations.js';
import { promptControls, resolveEditablePromptValues } from '../core/risu-prompt.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

/** Repair updates the retained combination identity, guarded by both revisions. */
export function promptCombinationRoutes(
  app: FastifyInstance,
  store: Store,
  getWorkspace: () => PromptWorkspace
) {
  app.put<{ Params: { id: string } }>('/api/prompt-combinations/:id', async (request) => {
    const b = record(request.body);
    fields(b, ['expectedRevision', 'sourceRevision', 'title', 'values']);
    return store.transaction(() => {
      store.product.assertAvailable('prompt-combination', request.params.id);
      const item = store.product.get<SavedPromptCombination>(
        'prompt-combination',
        request.params.id
      );
      if (!item.owner)
        throw new HttpError(
          409,
          '소속을 확인할 수 없는 이전 조합이에요. 새 조합으로 저장해 주세요.'
        );
      const current =
        item.owner.kind === 'preset'
          ? store.product.get<PromptPreset>('prompt-preset', item.owner.id)
          : getWorkspace()[item.role];
      if (item.owner.kind === 'preset')
        store.product.assertAvailable('prompt-preset', item.owner.id);
      if ('role' in current && current.role !== item.role)
        throw new HttpError(409, 'Prompt role mismatch');
      if (!ownsPromptCombination(item, item.owner, item.role))
        throw new HttpError(409, 'Prompt role mismatch');
      const sourceRevision = 'revision' in current ? current.revision : getWorkspace().revision;
      if (sourceRevision !== number(b.sourceRevision, 'prompt revision'))
        throw new HttpError(409, '프롬프트 저장본이 변경됐어요. 조합을 다시 확인해 주세요.');
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
  });
}
