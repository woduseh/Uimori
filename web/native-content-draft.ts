import type { RisuContent } from '../core/risu-content.js';
import type { ContentKind } from '../core/product.js';

/** The native name owns the projected title, including copies made from list actions. */
export function withNativeContentTitle(value: RisuContent, title: string): RisuContent {
  const next = structuredClone(value);
  next.title = title;
  if (!Object.keys(next.nativeRisu.card).length && next.nativeRisu.module)
    next.nativeRisu.module.name = title;
  else next.nativeRisu.card.name = title;
  return next;
}

/** New documents begin with Risu source; saved documents never pass through a conversion fallback. */
export function nativeContentDraft(kind: ContentKind): RisuContent {
  return {
    version: 1,
    id: 'draft',
    revision: 1,
    title: '',
    description: '',
    body: '',
    lore: [],
    instructions: [],
    nativeRisu: {
      version: 1,
      card:
        kind === 'module'
          ? {}
          : { name: '', description: '', first_mes: '', extensions: { risuai: {} } },
      ...(kind === 'module'
        ? { module: { name: '', description: '', lorebook: [], regex: [], trigger: [] } }
        : {}),
      assets: [],
      sourceHash: '0'.repeat(64),
    },
  };
}
