import type { ContentRef } from '../core/product.js';

export const refValue = (item: ContentRef) => `${item.id}@${item.revision}`;
