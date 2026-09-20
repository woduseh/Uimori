import {
  stripDeprecatedRisuCardFields,
  stripDeprecatedRisuModuleFields,
} from './risu-deprecated-fields.js';

/** Risu documents remain the authored source; package fields are UI/runtime projections. */
export type RisuContentSource = {
  version: 1;
  card: Record<string, unknown>;
  module?: Record<string, unknown>;
  assets: { name: string; uri: string; imageId: string }[];
  sourceHash: string;
};
export type NativeRisuRegex = Record<string, unknown> & {
  in: string;
  out: string;
  type: string;
  flag?: string;
  ableFlag?: boolean;
};
/** Authored native lore placement, separate from Uimori's retained/background lore policy. */
export type NativeRisuLorePosition = {
  mode: 'lore' | 'depth' | 'reverse_depth';
  depth: number;
  role: 'system' | 'user' | 'assistant';
  order: number;
};
/** New saves and live runtime views omit retired fields without rewriting historical records. */
export function normalizeRisuContentSource(native: RisuContentSource): RisuContentSource {
  const result = structuredClone(native);
  stripDeprecatedRisuCardFields(result.card);
  if (result.module) stripDeprecatedRisuModuleFields(result.module);
  return result;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    : [];
export const nativeRisuExtension = (native: RisuContentSource) =>
  object(object(native.card.extensions).risuai);
/** Embedded modules replace inline scripts, including when their list is empty. */
export function nativeRisuRegex(native: RisuContentSource): NativeRisuRegex[] {
  return records(
    native.module ? native.module.regex : nativeRisuExtension(native).customScripts
  ).filter(
    (item) =>
      typeof item.in === 'string' && typeof item.out === 'string' && typeof item.type === 'string'
  ) as NativeRisuRegex[];
}
export function nativeRisuTriggers(native: RisuContentSource): Record<string, unknown>[] {
  // Embedded modules become character scripts in Risu; standalone modules own their permission.
  const lowLevelAccess =
    (Object.keys(native.card).length ? nativeRisuExtension(native) : native.module)
      ?.lowLevelAccess === true;
  return records(
    native.module ? native.module.trigger : nativeRisuExtension(native).triggerscript
  ).map((trigger) => ({ ...trigger, lowLevelAccess }));
}
export function nativeRisuLore(native: RisuContentSource): Record<string, unknown>[] {
  return records(native.module?.lorebook ?? object(native.card.character_book).entries);
}
export function nativeRisuBackground(native: RisuContentSource): string {
  const value = nativeRisuExtension(native).backgroundHTML;
  return typeof value === 'string' ? value : '';
}
/** Risu card names may omit the separately serialized extension (e.g. Hinano_* + webp). */
export function nativeRisuAssetNames(
  native: RisuContentSource,
  asset: RisuContentSource['assets'][number]
): string[] {
  const original = records(native.card.assets).find(
    (entry) => entry.uri === asset.uri && entry.name === asset.name
  );
  const extension =
    typeof original?.ext === 'string' && /^[a-z0-9]{1,12}$/iu.test(original.ext)
      ? original.ext
      : '';
  return [
    ...new Set([
      asset.name,
      asset.uri,
      ...(extension && !asset.name.toLowerCase().endsWith(`.${extension.toLowerCase()}`)
        ? [`${asset.name}.${extension}`]
        : []),
    ]),
  ];
}
/** Validate bounded JSON data without interpreting authored CBS, regex or Lua. */
export function assertRisuContentSource(value: unknown): asserts value is RisuContentSource {
  const source = object(value);
  if (
    source.version !== 1 ||
    Object.keys(source).some(
      (key) => !['version', 'card', 'module', 'assets', 'sourceHash'].includes(key)
    ) ||
    !source.card ||
    typeof source.card !== 'object' ||
    Array.isArray(source.card) ||
    (source.module !== undefined &&
      (!source.module || typeof source.module !== 'object' || Array.isArray(source.module))) ||
    typeof source.sourceHash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(source.sourceHash) ||
    !Array.isArray(source.assets) ||
    source.assets.length > 2000
  )
    throw new Error('PACKAGE_NATIVE_RISU_INVALID');
  for (const asset of source.assets) {
    const a = object(asset);
    if (
      Object.keys(a).some((key) => !['name', 'uri', 'imageId'].includes(key)) ||
      typeof a.name !== 'string' ||
      a.name.length > 4000 ||
      typeof a.uri !== 'string' ||
      a.uri.length > 16_384 ||
      typeof a.imageId !== 'string' ||
      !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/u.test(a.imageId)
    )
      throw new Error('PACKAGE_NATIVE_RISU_ASSET');
  }
  const pending: { value: unknown; depth: number }[] = [{ value: source, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (++count > 250_000 || next.depth > 100) throw new Error('PACKAGE_NATIVE_RISU_LIMIT');
    if (next.value === null || ['string', 'boolean'].includes(typeof next.value)) continue;
    if (typeof next.value === 'number' && Number.isFinite(next.value)) continue;
    if (typeof next.value !== 'object') throw new Error('PACKAGE_NATIVE_RISU_JSON');
    for (const item of Object.values(next.value))
      pending.push({ value: item, depth: next.depth + 1 });
  }
  if (new TextEncoder().encode(JSON.stringify(source)).byteLength > 8 * 1024 * 1024)
    throw new Error('PACKAGE_NATIVE_RISU_LIMIT');
}

/** Editors and external callers retain the detached-copy contract. */
export function validateRisuContentSource(value: unknown): RisuContentSource {
  assertRisuContentSource(value);
  return structuredClone(value);
}
