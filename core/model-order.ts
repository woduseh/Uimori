import type { Connection, ModelPreset } from './product.js';

export function compareModelDisplayOrder(a: ModelPreset, b: ModelPreset): number {
  return (
    (a.displayOrder ?? Number.MAX_SAFE_INTEGER) - (b.displayOrder ?? Number.MAX_SAFE_INTEGER) ||
    a.title.localeCompare(b.title, 'ko') ||
    a.id.localeCompare(b.id)
  );
}
export function compareConnectionDisplayOrder(a: Connection, b: Connection): number {
  return (a.displayOrder ?? Number.MAX_SAFE_INTEGER) - (b.displayOrder ?? Number.MAX_SAFE_INTEGER);
}
