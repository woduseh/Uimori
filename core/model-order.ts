import type { ModelPreset } from './product.js';

/** Missing ranks use stable title order until the first manual move. */
export function compareModelDisplayOrder(a: ModelPreset, b: ModelPreset): number {
  return (
    (a.displayOrder ?? Number.MAX_SAFE_INTEGER) - (b.displayOrder ?? Number.MAX_SAFE_INTEGER) ||
    a.title.localeCompare(b.title, 'ko') ||
    a.id.localeCompare(b.id)
  );
}
