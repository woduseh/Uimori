import type { RisuContent } from '../core/risu-content.js';
import type { ContentKind } from '../core/product.js';

export function withNativeContentTitle(value: RisuContent, title: string): RisuContent {
  const native = value.nativeRisu;
  return {
    ...value,
    title,
    nativeRisu:
      !Object.keys(native.card).length && native.module
        ? { ...native, module: { ...native.module, name: title } }
        : { ...native, card: { ...native.card, name: title } },
  };
}

export function nativeContentDraft(kind: ContentKind): RisuContent {
  return {
    version: 2,
    id: 'draft',
    revision: 1,
    title: '',
    description: '',
    body: '',
    lore: [],
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
