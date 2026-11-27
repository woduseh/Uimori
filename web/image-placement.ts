import type { Asset } from '../core/product.js';

type ImagePlacement = {
  assetRef: string;
  assetRevision: number;
  assetHash: string;
  presentationIntent: 'inline' | 'profile';
};
export function resolveInlineImage(
  assets: readonly Asset[],
  chatId: string,
  annotation: ImagePlacement
): Asset | undefined {
  if (annotation.presentationIntent !== 'inline') return;
  const matches = assets.filter(
    (asset) =>
      asset.id === annotation.assetRef &&
      asset.chatId === chatId &&
      asset.revision === annotation.assetRevision &&
      asset.hash === annotation.assetHash &&
      asset.allowedUse !== 'profile'
  );
  return matches.length === 1 ? matches[0] : undefined;
}
