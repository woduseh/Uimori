import type { Asset, ProfileSnapshot } from './product.js';
import { packageImages } from './package-images.js';
import { nativeRisuAssetNameResolver } from './risu-native.js';
import { parseStoryUi } from './story-ui.js';

export function imageOwnerDisplayText(
  text: string,
  profile: Pick<ProfileSnapshot, 'image' | 'chatId' | 'packages' | 'packageAttachments'>,
  assets: readonly (Pick<Asset, 'url'> & Partial<Pick<Asset, 'allowedUse'>>)[] = [],
  authoredTags: readonly string[] = []
): string {
  return createImageOwnerDisplayText(profile, assets, authoredTags)(text);
}

export function createImageOwnerDisplayText(
  profile: Pick<ProfileSnapshot, 'image' | 'chatId' | 'packages' | 'packageAttachments'>,
  assets: readonly (Pick<Asset, 'url'> & Partial<Pick<Asset, 'allowedUse'>>)[] = [],
  authoredTags: readonly string[] = []
): (text: string) => string {
  if (!profile.image) return (text) => text;
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
  const tags = new Set(authoredTags);
  const imageReferences = new Set<string>();
  for (const pkg of profile.packages ?? []) {
    if (!pkg.nativeRisu) continue;
    const placeable = new Set(
      (pkg.images ?? [])
        .filter((image) => image.allowedUse !== 'profile' && image.id !== pkg.portraitImageId)
        .map((image) => image.id)
    );
    const assetNames = nativeRisuAssetNameResolver(pkg.nativeRisu);
    for (const asset of pkg.nativeRisu.assets) {
      if (!placeable.has(asset.imageId)) continue;
      for (const name of assetNames(asset)) {
        for (const type of ['img', 'image', 'emotion', 'asset']) tags.add(`{{${type}::${name}}}`);
        for (const type of ['raw', 'path', 'source']) imageReferences.add(`{{${type}::${name}}}`);
        for (const template of pkg.imageHandoff?.tagTemplates ?? [])
          tags.add(template.replace('{asset}', name));
      }
    }
  }
  const projectProse = (prose: string) => {
    let projected = prose;
    for (const tag of tags) projected = projected.split(tag).join('');
    projected = projected.replace(
      /!\[[^\]\r\n]*\]\(([^\s)]+)(?:\s+"[^"\r\n]*")?\)/gu,
      (tag, url) => (urls.has(url) || imageReferences.has(url) ? '' : tag)
    );
    return projected.replace(/<img\b[^>]*>/giu, (tag) => {
      const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(tag);
      const url = src?.[1] ?? src?.[2] ?? src?.[3];
      return url && (urls.has(url) || imageReferences.has(url)) ? '' : tag;
    });
  };
  return (text) => {
    if (!text.includes('```uimori-ui') && !text.includes('<a2ui>')) return projectProse(text);
    return parseStoryUi(text)
      .map((part) =>
        part.kind === 'prose' ? projectProse(part.text) : text.slice(part.start, part.end)
      )
      .join('');
  };
}
