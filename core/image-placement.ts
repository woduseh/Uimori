import type { Asset, ProfileSnapshot } from './product.js';
import { packageImages } from './package-images.js';
import { nativeRisuAssetNames } from './risu-native.js';

/** JEV owns catalog images in this display copy; stored prose is never rewritten. */
export function imageOwnerDisplayText(
  text: string,
  profile: Pick<ProfileSnapshot, 'image' | 'chatId' | 'packages' | 'packageAttachments'>,
  assets: readonly (Pick<Asset, 'url'> & Partial<Pick<Asset, 'allowedUse'>>)[] = []
): string {
  if (!profile.image) return text;
  const urls = new Set([
    ...assets.filter((asset) => asset.allowedUse !== 'profile').map((asset) => asset.url),
    ...packageImages(profile)
      .filter(
        (asset) =>
          asset.allowedUse !== 'profile' &&
          profile.packages?.find((pkg) => pkg.id === asset.packageOwner?.id)?.portraitImageId !==
            asset.packageOwner?.imageId
      )
      .map((asset) => asset.url),
  ]);
  const tags = new Set<string>();
  const imageReferences = new Set<string>();
  for (const pkg of profile.packages ?? []) {
    if (!pkg.nativeRisu) continue;
    for (const asset of pkg.nativeRisu.assets) {
      if (
        !pkg.images?.some(
          (image) =>
            image.id === asset.imageId &&
            image.allowedUse !== 'profile' &&
            image.id !== pkg.portraitImageId
        )
      )
        continue;
      for (const name of nativeRisuAssetNames(pkg.nativeRisu, asset)) {
        for (const type of ['img', 'image', 'emotion', 'asset']) tags.add(`{{${type}::${name}}}`);
        for (const type of ['raw', 'path', 'source']) imageReferences.add(`{{${type}::${name}}}`);
        for (const template of pkg.imageHandoff?.tagTemplates ?? [])
          tags.add(template.replace('{asset}', name));
      }
    }
  }
  let projected = text;
  for (const tag of tags) projected = projected.split(tag).join('');
  projected = projected.replace(/!\[[^\]\r\n]*\]\(([^\s)]+)(?:\s+"[^"\r\n]*")?\)/gu, (tag, url) =>
    urls.has(url) || imageReferences.has(url) ? '' : tag
  );
  return projected.replace(/<img\b[^>]*>/giu, (tag) => {
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(tag);
    const url = src?.[1] ?? src?.[2] ?? src?.[3];
    return url && (urls.has(url) || imageReferences.has(url)) ? '' : tag;
  });
}
