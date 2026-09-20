import { createHash } from 'node:crypto';
import type { Content } from '../core/product.js';
import {
  nativeRisuExtension,
  nativeRisuLore,
  nativeRisuRegex,
  nativeRisuTriggers,
  nativeRisuAssetNames,
} from '../core/risu-native.js';
import type { ProductStore } from './product-store.js';
import { resolvePackageModules } from './package-features.js';
import { HttpError } from './request-validation.js';
import { convertCharbook, type RisuCharacterBook } from './compat/risu/lorebook.js';

const conflict = (): never => {
  throw new HttpError(409, 'RISU_EXPORT_MODULE_CONFLICT');
};
const meaningful = (value: unknown): boolean =>
  value !== '' &&
  value !== false &&
  value != null &&
  (Array.isArray(value)
    ? value.length > 0
    : typeof value !== 'object' || Object.keys(value).length > 0);

/** A CHARX has one character permission scope. Flatten only representable module closures. */
export function bundleRisuModules(product: ProductStore, content: Content): Content {
  if (!content.package.modules?.length) return structuredClone(content);
  const result = structuredClone(content),
    pkg = result.package;
  const linked = resolvePackageModules(
    product,
    pkg.modules!.map((ref) => ({ ...ref, role: 'module' })),
    { latest: true }
  ).packages;
  if (linked.some((item) => item.id === pkg.id)) return conflict();
  const natives = [pkg.nativeRisu, ...linked.map((item) => item.nativeRisu)];
  const triggers = natives.flatMap(nativeRisuTriggers);
  const permissions = new Set(triggers.map((trigger) => trigger.lowLevelAccess === true));
  if (permissions.size > 1) return conflict();
  const native = pkg.nativeRisu;
  // Risu ignores module-level permissions on embedded modules; the card owns them.
  const extension = nativeRisuExtension(native);
  native.card.extensions = {
    ...(native.card.extensions as object),
    risuai: { ...extension, ...(triggers.length ? { lowLevelAccess: permissions.has(true) } : {}) },
  };
  const lore = natives.flatMap((source) => {
    if (source.module?.lorebook !== undefined) return nativeRisuLore(source);
    const book = structuredClone(
      source.card.character_book ?? { entries: [] }
    ) as RisuCharacterBook;
    book.entries = (book.entries ?? []).map((entry) => ({
      ...entry,
      keys: entry.keys ?? [],
      extensions: entry.extensions ?? {},
      content: entry.content ?? '',
    }));
    return convertCharbook({
      charbook: book,
      lorebook: [],
      loresettings: undefined,
      loreExt: undefined,
    }).lorebook.map((entry) => ({ ...entry }));
  });
  const merged = {
    ...native.module,
    lorebook: lore,
    regex: natives.flatMap(nativeRisuRegex),
    trigger: triggers.map(({ lowLevelAccess: _permission, ...trigger }) => trigger),
  };
  const assets = [...(Array.isArray(native.card.assets) ? native.card.assets : [])];
  const names = new Set(native.assets.flatMap((asset) => nativeRisuAssetNames(native, asset)));
  pkg.images ??= [];
  for (const dependency of linked) {
    const source = dependency.nativeRisu;
    // These fields need their own module identity or a separate character scope.
    const supported = new Set([
      'name',
      'description',
      'id',
      'lorebook',
      'regex',
      'trigger',
      'assets',
      'icon',
      'lowLevelAccess',
    ]);
    for (const [key, value] of Object.entries(source.module ?? {}))
      if (!supported.has(key) && meaningful(value)) return conflict();
    const ext = nativeRisuExtension(source);
    for (const [key, value] of Object.entries(
      (source.card.extensions ?? {}) as Record<string, unknown>
    ))
      if (key !== 'risuai' && meaningful(value)) return conflict();
    for (const [key, value] of Object.entries(ext))
      if (!['customScripts', 'triggerscript', 'lowLevelAccess'].includes(key) && meaningful(value))
        return conflict();
    // A linked character can contain non-module behavior; do not discard it during flattening.
    for (const [key, value] of Object.entries(source.card))
      if (
        !['name', 'creator_notes', 'extensions', 'character_book', 'assets'].includes(key) &&
        meaningful(value)
      )
        return conflict();
    if (
      (source.module?.assets !== undefined && !Array.isArray(source.module.assets)) ||
      (source.card.assets !== undefined && !Array.isArray(source.card.assets))
    )
      throw new HttpError(409, 'RISU_EXPORT_ASSET_UNAVAILABLE');
    if (source.module?.icon && !source.assets.some((asset) => asset.name === 'main'))
      throw new HttpError(409, 'RISU_EXPORT_ASSET_UNAVAILABLE');
    for (const entry of Array.isArray(source.module?.assets) ? source.module.assets : [])
      if (!Array.isArray(entry) || !source.assets.some((asset) => asset.name === entry[0]))
        throw new HttpError(409, 'RISU_EXPORT_ASSET_UNAVAILABLE');
    for (const entry of Array.isArray(source.card.assets) ? source.card.assets : []) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        !source.assets.some((asset) => asset.uri === entry.uri)
      )
        throw new HttpError(409, 'RISU_EXPORT_ASSET_UNAVAILABLE');
    }
    for (const image of dependency.images ?? []) {
      const bindings = source.assets.filter((asset) => asset.imageId === image.id);
      const assetNames = bindings.length ? bindings.map((asset) => asset.name) : [image.title];
      const id = `export-${createHash('sha256').update(`${dependency.id}:${image.id}`).digest('hex').slice(0, 40)}`;
      const ext = image.mime === 'image/jpeg' ? 'jpg' : image.mime.slice(6);
      const uri = `embeded://assets/uimori/${id}.${ext}`;
      pkg.images.push({ ...image, id });
      for (const name of new Set(assetNames)) {
        const moduleAsset = (Array.isArray(source.module?.assets) ? source.module.assets : []).find(
          (entry) => Array.isArray(entry) && entry[0] === name
        );
        const cardAsset = (Array.isArray(source.card.assets) ? source.card.assets : []).find(
          (entry) => entry && typeof entry === 'object' && entry.name === name
        );
        const authoredExtension = moduleAsset?.[2] ?? cardAsset?.ext ?? ext;
        if (typeof authoredExtension !== 'string' || !/^[a-z0-9]{1,12}$/iu.test(authoredExtension))
          return conflict();
        const aliases = new Set([
          name,
          name.toLowerCase().endsWith(`.${authoredExtension.toLowerCase()}`)
            ? name
            : `${name}.${authoredExtension}`,
        ]);
        if ([...aliases].some((alias) => names.has(alias))) return conflict();
        for (const alias of aliases) names.add(alias);
        assets.push({ name, uri, type: 'x-risu-asset', ext: authoredExtension });
        native.assets.push({ name, uri, imageId: id });
      }
    }
    for (const binding of source.assets)
      if (!dependency.images?.some((image) => image.id === binding.imageId))
        throw new HttpError(409, 'RISU_EXPORT_ASSET_UNAVAILABLE');
  }
  // Upstream lore conversion uses optional undefined fields; authored sources are bounded JSON.
  native.module = JSON.parse(JSON.stringify(merged));
  native.card.assets = assets;
  delete pkg.modules;
  return result;
}
