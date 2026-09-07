import type { Asset } from './product.js';

export type AssetRef = Pick<Asset, 'id' | 'revision' | 'hash'>;
export type AssetUse = 'inline' | 'profile';
export type AssetMetadata = Omit<Asset, 'url'>;
export type AssetSearch = {
  chatId: string;
  query?: string;
  actor?: string;
  outfit?: string;
  location?: string;
  allowedUse?: AssetUse;
  offset?: number;
  limit?: number;
};
export type AssetSelection = {
  chatId: string;
  ref: AssetRef;
  use: AssetUse;
  actor?: string;
  outfit?: string;
  location?: string;
};
export type AssetResolution =
  | { ok: true; asset: AssetMetadata }
  | { ok: false; fallback: 'no-image'; error: string };
const metadata = (asset: Asset): AssetMetadata => ({
  id: asset.id,
  chatId: asset.chatId,
  revision: asset.revision,
  hash: asset.hash,
  title: asset.title,
  mime: asset.mime,
  description: asset.description,
  actor: asset.actor,
  outfit: asset.outfit,
  location: asset.location,
  allowedUse: asset.allowedUse,
});
const validText = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length <= max;
const validRef = (ref: AssetRef) =>
  ref &&
  validText(ref.id) &&
  ref.id.length > 0 &&
  Number.isSafeInteger(ref.revision) &&
  ref.revision > 0 &&
  validText(ref.hash) &&
  ref.hash.length > 0;
const validAsset = (asset: Asset) =>
  validRef(asset) &&
  validText(asset.chatId) &&
  validText(asset.title) &&
  validText(asset.mime, 128) &&
  validText(asset.description, 2_048) &&
  validText(asset.actor) &&
  validText(asset.outfit) &&
  validText(asset.location) &&
  ['inline', 'profile', 'both'].includes(asset.allowedUse);
const matches = (asset: Asset, filter: { actor?: string; outfit?: string; location?: string }) =>
  (['actor', 'outfit', 'location'] as const).every(
    (key) => filter[key] === undefined || asset[key] === filter[key]
  );
const allowed = (asset: Asset, use: AssetUse) =>
  asset.allowedUse === 'both' || asset.allowedUse === use;
const validFilters = (filter: { actor?: string; outfit?: string; location?: string }) =>
  (['actor', 'outfit', 'location'] as const).every(
    (key) => filter[key] === undefined || validText(filter[key])
  );

/** Compact author-provided metadata only: no URL, filename inference, bytes or base64. */
export function searchAssets(
  assets: readonly Asset[],
  search: AssetSearch
): { items: AssetMetadata[]; total: number; nextOffset: number | null } {
  const { offset = 0, limit = 20 } = search;
  if (
    !validText(search.chatId) ||
    !search.chatId ||
    !validFilters(search) ||
    (search.query !== undefined && !validText(search.query, 200)) ||
    (search.allowedUse !== undefined && !['inline', 'profile'].includes(search.allowedUse)) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new Error('INVALID_ASSET_SEARCH');
  const query = (search.query ?? '').toLocaleLowerCase();
  const found = assets
    .filter(
      (asset) =>
        validAsset(asset) &&
        asset.chatId === search.chatId &&
        matches(asset, search) &&
        (!search.allowedUse || allowed(asset, search.allowedUse)) &&
        (!query ||
          [asset.title, asset.description, asset.actor, asset.outfit, asset.location].some(
            (value) => value.toLocaleLowerCase().includes(query)
          ))
    )
    .sort(
      (a, b) => a.id.localeCompare(b.id) || a.revision - b.revision || a.hash.localeCompare(b.hash)
    );
  return {
    items: found.slice(offset, offset + limit).map(metadata),
    total: found.length,
    nextOffset: offset + limit < found.length ? offset + limit : null,
  };
}

/** An exact pinned ref plus scene combination is required; omission is a normal fallback. */
export function resolveAsset(assets: readonly Asset[], selection: AssetSelection): AssetResolution {
  const fail = (error: string): AssetResolution => ({ ok: false, fallback: 'no-image', error });
  if (
    !selection ||
    !validText(selection.chatId) ||
    !selection.chatId ||
    !validRef(selection.ref) ||
    !['inline', 'profile'].includes(selection.use) ||
    !validFilters(selection)
  )
    return fail('INVALID_ASSET_SELECTION');
  const candidates = assets.filter(
    (asset) => asset.chatId === selection.chatId && asset.id === selection.ref.id
  );
  if (!candidates.length) return fail('ASSET_MISSING');
  const pinned = candidates.filter(
    (asset) => asset.revision === selection.ref.revision && asset.hash === selection.ref.hash
  );
  if (!pinned.length) return fail('ASSET_STALE');
  if (pinned.length !== 1) return fail('ASSET_AMBIGUOUS');
  const asset = pinned[0];
  if (!validAsset(asset)) return fail('INVALID_ASSET_METADATA');
  if (!allowed(asset, selection.use)) return fail('ASSET_USE_DENIED');
  if (!matches(asset, selection)) return fail('ASSET_COMBINATION_MISMATCH');
  return { ok: true, asset: metadata(asset) };
}
