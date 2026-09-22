import { createHash } from 'node:crypto';
import { projectNativeRisuPackage } from '../dist/server/risu-native-projection.js';

/** Current native authoring format, shared by manual storage measurements. */
export function createSyntheticBot(store) {
  const card = { name: 'Synthetic measurement bot', description: '', creator_notes: '' };
  const pkg = projectNativeRisuPackage(
    {
      version: 2,
      id: 'measurement',
      revision: 1,
      title: card.name,
      description: '',
      lore: [],
      nativeRisu: {
        version: 1,
        card,
        assets: [],
        sourceHash: createHash('sha256').update(JSON.stringify(card)).digest('hex'),
      },
    },
    'bot'
  ).pkg;
  return store.product.content({
    kind: 'bot',
    title: card.name,
    description: '',
    text: '',
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  });
}
