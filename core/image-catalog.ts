import type { AssetEntry } from './auxiliary.js';

/** Model-visible, authored metadata only. URLs and image bytes stay with the host. */
export type ImageMetadata = Omit<AssetEntry, 'url'>;
export function imageMetadata(asset: ImageMetadata): ImageMetadata {
  return { ref: asset.ref, revision: asset.revision, hash: asset.hash, alt: asset.alt, caption: asset.caption, actorId: asset.actorId, clothing: asset.clothing, location: asset.location, uses: [...asset.uses] };
}
export function imageCatalogPage(assets: readonly ImageMetadata[], query = '', offset = 0, limit = 20) {
  if (typeof query !== 'string' || query.length > 200 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('ASSET_SEARCH_INVALID');
  const needle = query.toLocaleLowerCase();
  const found = assets.filter(asset => [asset.ref, asset.alt, asset.caption, asset.actorId, asset.clothing, asset.location].some(value => value?.toLocaleLowerCase().includes(needle)));
  const items: ImageMetadata[] = []; let size = 0;
  for (const asset of found.slice(offset, offset + limit)) {
    const item = imageMetadata(asset), length = JSON.stringify(item).length;
    if (length > 16_000) throw new Error('ASSET_METADATA_LIMIT');
    if (size + length > 16_000) break;
    items.push(item); size += length;
  }
  return { items, total: found.length, nextOffset: offset + items.length < found.length ? offset + items.length : null };
}
