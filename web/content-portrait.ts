import type { Content } from '../core/product.js';
import type { RisuContent } from '../core/risu-content.js';

export function contentPortraitUrl(content?: Content | null): string {
  if (!content?.package) return content?.coverImage?.url ?? '';
  const portrait = content.package.images?.find(
    (image) => image.id === content.package?.portraitImageId && image.allowedUse !== 'inline'
  );
  return portrait ? `/api/package-image-blobs/${portrait.blobHash}` : '';
}

export function withPortraitImage(value: RisuContent, imageId: string) {
  const selected = value.images?.find((image) => image.id === imageId);
  if (!selected) return null;
  return {
    value: {
      ...value,
      portraitImageId: selected.id,
      images: value.images?.map((image) =>
        image.id === selected.id && image.allowedUse === 'inline'
          ? { ...image, allowedUse: 'both' as const }
          : image
      ),
    },
    widenedUse: selected.allowedUse === 'inline',
  };
}
