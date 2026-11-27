import { RISU_ASSET_MAX } from './risu-limits.js';
import type { PackageImage } from './package-images.js';
import type { RisuContent } from './risu-content.js';
import { ValidationError } from './validation-error.js';

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    : [];
const moduleUri = (uri: string) => /^embeded:\/\/(?:__risu_module__\/)?module-assets\//u.test(uri);
const extension = (image: PackageImage) =>
  image.mime === 'image/jpeg' ? 'jpg' : image.mime.slice(6);

export function nativeImageNames(pkg: RisuContent, imageId: string): string[] {
  return [
    ...new Set(
      pkg.nativeRisu.assets.filter((asset) => asset.imageId === imageId).map((asset) => asset.name)
    ),
  ];
}
export function unmappedNativeAssetCount(pkg: RisuContent): number {
  const native = pkg.nativeRisu;
  const imageIds = new Set(pkg.images?.map((image) => image.id));
  const namesByUri = new Map<string, Set<string>>();
  const moduleNames = new Set<string>();
  for (const asset of native.assets) {
    if (!imageIds.has(asset.imageId)) continue;
    let names = namesByUri.get(asset.uri);
    if (!names) namesByUri.set(asset.uri, (names = new Set()));
    names.add(asset.name);
    if (moduleUri(asset.uri)) moduleNames.add(asset.name);
  }
  const available = (uri: string, name: unknown) =>
    typeof name === 'string' && namesByUri.get(uri)?.has(name);
  const card = records(native.card.assets).filter(
    (asset) => typeof asset.uri !== 'string' || !available(asset.uri, asset.name)
  ).length;
  const module = Array.isArray(native.module?.assets) ? native.module.assets : [];
  return (
    card + module.filter((entry) => !Array.isArray(entry) || !moduleNames.has(entry[0])).length
  );
}
export function addNativeRisuImage(value: RisuContent, uploaded: PackageImage): RisuContent {
  if (
    (value.images?.length ?? 0) >= RISU_ASSET_MAX ||
    value.images?.some((image) => image.id === uploaded.id)
  )
    throw new ValidationError(
      400,
      'RISU_ASSET_ADD_INVALID',
      `The package already has ${RISU_ASSET_MAX} images or an image with ID ${uploaded.id}.`
    );
  const next = structuredClone(value),
    native = next.nativeRisu;
  const names = new Set(
    [
      ...native.assets.map((asset) => asset.name),
      ...records(native.card.assets).flatMap((asset) =>
        typeof asset.name === 'string' ? [asset.name] : []
      ),
      ...(Array.isArray(native.module?.assets)
        ? native.module.assets.flatMap((asset) =>
            Array.isArray(asset) && typeof asset[0] === 'string' ? [asset[0]] : []
          )
        : []),
    ].map((name) => name.toLocaleLowerCase())
  );
  const base = uploaded.title.trim() || 'image';
  let name = base,
    suffix = 2;
  while (names.has(name.toLocaleLowerCase())) name = `${base.slice(0, 180)}-${suffix++}`;
  const standalone = !Object.keys(native.card).length && !!native.module;
  const uri = `embeded://${standalone ? 'module-assets' : 'assets/uimori'}/${uploaded.id}.${extension(uploaded)}`;
  if (standalone) {
    native.module!.assets = [
      ...(Array.isArray(native.module!.assets) ? native.module!.assets : []),
      [name, uri, extension(uploaded)],
    ];
  } else {
    native.card.assets = [
      ...(Array.isArray(native.card.assets) ? native.card.assets : []),
      { type: 'x-risu-asset', name, uri, ext: extension(uploaded) },
    ];
  }
  native.assets.push({ name, uri, imageId: uploaded.id });
  next.images = [...(next.images ?? []), { ...uploaded, title: name }];
  return next;
}
export function replaceNativeRisuImage(
  value: RisuContent,
  imageId: string,
  uploaded: PackageImage
): RisuContent {
  if (!value.images?.some((image) => image.id === imageId))
    throw new ValidationError(
      409,
      'RISU_ASSET_REPLACE_STALE',
      `Image ${imageId} is no longer in the package; choose the image to replace again.`
    );
  return {
    ...value,
    images: value.images.map((image) =>
      image.id === imageId ? { ...image, blobHash: uploaded.blobHash, mime: uploaded.mime } : image
    ),
  };
}
export function removeNativeRisuImage(value: RisuContent, imageId: string): RisuContent {
  const next = structuredClone(value),
    native = next.nativeRisu;
  const removed = native.assets.filter((asset) => asset.imageId === imageId);
  const moduleNames = new Set(
    removed.filter((asset) => moduleUri(asset.uri)).map((asset) => asset.name)
  );
  const moduleHadMainAsset =
    Array.isArray(native.module?.assets) &&
    native.module.assets.some((entry) => Array.isArray(entry) && entry[0] === 'main');
  if (moduleNames.has('main') && native.module?.icon && moduleHadMainAsset)
    throw new ValidationError(
      400,
      'RISU_ASSET_MODULE_ICON_CONFLICT',
      'The module has both an icon and an asset named main; resolve that entry in the module source first.'
    );
  if (native.module && Array.isArray(native.module.assets)) {
    for (const name of moduleNames)
      if (
        native.module.assets.filter((entry) => Array.isArray(entry) && entry[0] === name).length > 1
      )
        throw new ValidationError(
          400,
          'RISU_ASSET_MODULE_DUPLICATE',
          `The module has several assets named ${name}; resolve them in the module source first.`
        );
    native.module.assets = native.module.assets.filter(
      (entry) => !Array.isArray(entry) || !moduleNames.has(entry[0])
    );
  }
  if (native.module?.icon && moduleNames.has('main') && !moduleHadMainAsset)
    delete native.module.icon;
  if (Array.isArray(native.card.assets))
    native.card.assets = native.card.assets.filter(
      (entry) =>
        !removed.some(
          (asset) =>
            entry &&
            typeof entry === 'object' &&
            (entry as Record<string, unknown>).uri === asset.uri
        )
    );
  native.assets = native.assets.filter((asset) => asset.imageId !== imageId);
  next.images = next.images?.filter((image) => image.id !== imageId);
  if (next.portraitImageId === imageId) delete next.portraitImageId;
  return next;
}
