import type { Asset } from '../core/product.js';

export type ImagePlacement = {
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

/** A block crossing a hidden boundary cannot safely donate its image to either side. */
export function containedImageAnchors(
  blocks: readonly { anchor: string; start: number; end: number }[],
  range: { start: number; end: number }
) {
  return blocks
    .filter(
      (block) => block.start >= range.start && block.end <= range.end && block.end > block.start
    )
    .map((block) => block.anchor);
}
export const IMAGE_POSITION_UNAVAILABLE =
  '표시 변환 후 이미지 위치를 확인할 수 없어 이 보기에서는 이미지를 생략했어요.';
