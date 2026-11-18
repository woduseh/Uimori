import { expect, it, vi } from 'vitest';
import type { PackageImage } from '../core/package-images.js';
import { defaultProfile } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { storyUiAssetResolver } from '../server/story-ui-assets.js';
import { nativeContent } from './fixtures/native-content.js';

it('resolves only unique inline CHARX names from the attached revisions', () => {
  const images: PackageImage[] = ['레이', 'Rei', 'REI', '초상'].map((title, index) => ({
    id: `image-${index}`,
    title,
    description: '',
    blobHash: String(index).repeat(64),
    mime: 'image/webp',
    allowedUse: index === 3 ? 'profile' : 'both',
  }));
  const assets = images.map((image) => ({
    name: image.title,
    uri: `embedded://${image.id}`,
    imageId: image.id,
  }));
  const card = nativeContent(
    { assets: assets.map(({ name, uri }) => ({ name, uri, ext: 'webp' })) },
    { images, portraitImageId: images[0].id }
  );
  card.nativeRisu.assets = assets;
  const unselected = structuredClone(card);
  unselected.revision++;
  unselected.images![0].blobHash = 'f'.repeat(64);
  const getSnapshot = vi.fn(
    (): RunSnapshot => ({
      chatId: 'chat',
      parentRevision: null,
      settingsRevision: 1,
      settings: { maxCalls: 4 },
      request: '',
      history: [],
      resources: [],
      profile: {
        ...defaultProfile('chat'),
        models: {},
        packages: [unselected, card],
        packageAttachments: [{ role: 'bot', id: card.id, revision: card.revision }],
      },
    })
  );
  const resolve = storyUiAssetResolver(getSnapshot);
  expect(getSnapshot).not.toHaveBeenCalled();
  const portrait = `/api/package-image-blobs/${'0'.repeat(64)}`;
  expect(resolve('레이')).toBe(portrait);
  expect(resolve('레이.WEBP')).toBe(portrait);
  expect(resolve('Rei')).toBeUndefined();
  expect(resolve('embedded://image-2')).toBe(`/api/package-image-blobs/${'2'.repeat(64)}`);
  expect(resolve('초상')).toBeUndefined();
  expect(resolve('레아')).toBeUndefined();
  expect(getSnapshot).toHaveBeenCalledTimes(1);
});
