import { isDeepStrictEqual } from 'node:util';
import type { ProductStore } from '../../server/product-store.js';
import { modelWorkspace, updateModelWorkspace } from '../../server/prompt-workspace.js';

/** Existing synthetic scenarios explicitly install their requested global routes before editing chat data. */
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
