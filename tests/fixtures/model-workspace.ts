import { isDeepStrictEqual } from 'node:util';
import type { ProductStore } from '../../server/product-store.js';
import { modelWorkspace, updateModelWorkspace } from '../../server/prompt-workspace.js';
import type { Store } from '../../server/store.js';

export function enableTranslationJudgment(store: Store) {
  const workspace = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: workspace.revision,
    routes: workspace.routes,
    translationPolicy: {
      ...workspace.translationPolicy,
      judgment: { ...workspace.translationPolicy.judgment, enabled: true },
    },
  });
}

export function updateTestProfile(
  product: ProductStore,
  chatId: string,
  value: Record<string, unknown>
) {
  const { routes, ...profile } = value;
  if (routes !== undefined) {
    const current = modelWorkspace(product.store);
    if (!isDeepStrictEqual(current.routes, routes))
      updateModelWorkspace(product.store, {
        expectedRevision: current.revision,
        routes,
        translationPolicy: current.translationPolicy,
      });
  }
  return product.updateProfile(chatId, profile);
}
