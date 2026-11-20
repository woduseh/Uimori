import type { Content } from '../core/product.js';

export function contentPortraitUrl(content?: Content | null): string {
  if (!content?.package) return content?.coverImage?.url ?? '';
  const portrait = content.package.images?.find(
    (image) => image.id === content.package?.portraitImageId && image.allowedUse !== 'inline'
  );
  return portrait ? `/api/package-image-blobs/${portrait.blobHash}` : '';
}
