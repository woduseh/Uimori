import { expect, test } from 'vitest';
import type { Content } from '../core/product.js';
import { contentPortraitUrl } from '../web/content-portrait.js';
import { nativeContent } from './fixtures/native-content.js';

function card(): Content {
  return {
    id: 'bot',
    revision: 3,
    kind: 'bot',
    title: '봇',
    description: '',
    text: '',
    loading: 'pinned',
    relatedIds: [],
    coverImage: { url: '/legacy-cover.png', title: 'Legacy' },
    package: nativeContent(
      {},
      {
        portraitImageId: 'cover',
        images: [
          {
            id: 'inline',
            title: 'Inline',
            description: '',
            blobHash: 'a'.repeat(64),
            mime: 'image/webp',
            allowedUse: 'inline',
          },
          {
            id: 'cover',
            title: 'Cover',
            description: '',
            blobHash: 'b'.repeat(64),
            mime: 'image/webp',
            allowedUse: 'profile',
          },
        ],
      }
    ),
  };
}

test('portrait resolution uses the selected card image rather than the first image or legacy cover', () => {
  expect(contentPortraitUrl(card())).toBe(`/api/package-image-blobs/${'b'.repeat(64)}`);
});
test('a missing or inline-only portrait does not fall back to other package or legacy images', () => {
  const content = card();
  for (const id of ['inline', 'missing', undefined]) {
    content.package.portraitImageId = id;
    expect(contentPortraitUrl(content)).toBe('');
  }
});
test('absent content has no portrait', () => {
  expect(contentPortraitUrl(null)).toBe('');
  expect(contentPortraitUrl(undefined)).toBe('');
});
