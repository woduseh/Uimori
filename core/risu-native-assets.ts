import type { PackageImage } from './package-images.js';
import type { RisuContent } from './risu-content.js';

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
/** Unavailable/non-image authored assets remain visible as a count and are never rewritten by image edits. */
export function unmappedNativeAssetCount(pkg: RisuContent): number {
  const native = pkg.nativeRisu;
  const available = (uri: string, name: unknown) =>
    native.assets.some(
      (asset) =>
        asset.uri === uri &&
        asset.name === name &&
        pkg.images?.some((image) => image.id === asset.imageId)
    );
  const card = records(native.card.assets).filter(
    (asset) => typeof asset.uri !== 'string' || !available(asset.uri, asset.name)
  ).length;
  const module = Array.isArray(native.module?.assets) ? native.module.assets : [];
  return (
    card +
    module.filter(
      (entry) =>
        !Array.isArray(entry) ||
        !native.assets.some(
          (asset) =>
            moduleUri(asset.uri) &&
            asset.name === entry[0] &&
            pkg.images?.some((image) => image.id === asset.imageId)
        )
    ).length
  );
}
/** Add portable metadata alongside the blob reference; a name collision never changes an existing identifier. */
export function addNativeRisuImage(value: RisuContent, uploaded: PackageImage): RisuContent {
  if (
    (value.images?.length ?? 0) >= 2000 ||
    value.images?.some((image) => image.id === uploaded.id)
  )
    throw new Error('이미지 개수 또는 식별자를 확인해 주세요.');
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
/** Keep IDs, names, URI and extension aliases: existing CBS/HTML references must keep resolving. */
export function replaceNativeRisuImage(
  value: RisuContent,
  imageId: string,
  uploaded: PackageImage
): RisuContent {
  if (!value.images?.some((image) => image.id === imageId))
    throw new Error('교체할 이미지가 변경됐어요. 다시 선택해 주세요.');
  return {
    ...value,
    images: value.images.map((image) =>
      image.id === imageId ? { ...image, blobHash: uploaded.blobHash, mime: uploaded.mime } : image
    ),
  };
}
/** Remove only this known image's metadata. Authored descriptions, Lua, HTML and lore stay byte-for-byte unchanged. */
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
    throw new Error(
      '모듈 대표 이미지와 같은 이름의 에셋이 있어요. 모듈 원문에서 해당 항목을 먼저 확인해 주세요.'
    );
  if (native.module && Array.isArray(native.module.assets)) {
    for (const name of moduleNames)
      if (
        native.module.assets.filter((entry) => Array.isArray(entry) && entry[0] === name).length > 1
      )
        throw new Error(
          '모듈에 같은 이름의 에셋이 여러 개 있어요. 모듈 원문에서 해당 항목을 먼저 확인해 주세요.'
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
