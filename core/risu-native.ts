import {
  illustrationProfilesValue,
  validateIllustrationAppearanceProfiles,
} from './illustration-profiles.js';
import { RISU_ASSET_MAX } from './risu-limits.js';
import { translationGuideValue, validateTranslationGuide } from './translation-guide.js';
import {
  stripDeprecatedRisuCardFields,
  stripDeprecatedRisuModuleFields,
} from './risu-deprecated-fields.js';

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
export type NativeRisuLorePosition = {
  mode: 'lore' | 'depth' | 'reverse_depth';
  depth: number;
  role: 'system' | 'user' | 'assistant';
  order: number;
};
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
export function nativeRisuRegexEntries(
  native: RisuContentSource
): { script: NativeRisuRegex; index: number }[] {
  const raw = native.module ? native.module.regex : nativeRisuExtension(native).customScripts;
  return (Array.isArray(raw) ? raw : []).flatMap((item, index) =>
    item &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    typeof item.in === 'string' &&
    typeof item.out === 'string' &&
    typeof item.type === 'string'
      ? [{ script: item as NativeRisuRegex, index }]
      : []
  );
}
export function nativeRisuRegex(native: RisuContentSource): NativeRisuRegex[] {
  return nativeRisuRegexEntries(native).map((entry) => entry.script);
}
export function nativeRisuTriggers(native: RisuContentSource): Record<string, unknown>[] {
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
export function nativeRisuSourcePaths(native: RisuContentSource) {
  const standalone = !Object.keys(native.card).length && !!native.module;
  const extension = '/card/extensions/risuai';
  return {
    root: standalone ? '/module' : '/card',
    lore: native.module?.lorebook != null ? '/module/lorebook' : '/card/character_book/entries',
    regex: native.module ? '/module/regex' : `${extension}/customScripts`,
    triggers: native.module ? '/module/trigger' : `${extension}/triggerscript`,
    background: standalone ? '/module/backgroundEmbedding' : `${extension}/backgroundHTML`,
    defaultVariables: standalone ? '/module/defaultVariables' : `${extension}/defaultVariables`,
    toggles: standalone ? '/module/customModuleToggle' : `${extension}/toggles`,
  };
}
export function nativeRisuBackground(native: RisuContentSource): string {
  const value = nativeRisuExtension(native).backgroundHTML;
  return typeof value === 'string' ? value : '';
}
export function nativeRisuModuleBackground(native: RisuContentSource): string {
  const value = native.module?.backgroundEmbedding;
  return typeof value === 'string' ? value : '';
}
export function joinRisuModuleBackgrounds(backgrounds: readonly string[]): string {
  return backgrounds.filter(Boolean).join('\n\n');
}
export function nativeRisuDisplayBackground(native: RisuContentSource): string {
  const character = nativeRisuBackground(native);
  const modules = nativeRisuModuleBackground(native);
  return modules ? `${character}\n\n${modules}\n` : character;
}
export function nativeRisuAssetNameResolver(native: RisuContentSource) {
  const byUri = new Map<unknown, Map<unknown, Record<string, unknown>>>();
  for (const entry of records(native.card.assets)) {
    let names = byUri.get(entry.uri);
    if (!names) byUri.set(entry.uri, (names = new Map()));
    if (!names.has(entry.name)) names.set(entry.name, entry);
  }
  return (asset: RisuContentSource['assets'][number]) =>
    assetNames(asset, byUri.get(asset.uri)?.get(asset.name));
}
export function nativeRisuAssetNames(
  native: RisuContentSource,
  asset: RisuContentSource['assets'][number]
): string[] {
  const original = records(native.card.assets).find(
    (entry) => entry.uri === asset.uri && entry.name === asset.name
  );
  return assetNames(asset, original);
}
function assetNames(
  asset: RisuContentSource['assets'][number],
  original: Record<string, unknown> | undefined
): string[] {
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
    source.assets.length > RISU_ASSET_MAX
  )
    throw new Error('PACKAGE_NATIVE_RISU_INVALID');
  for (const document of [source.card, source.module]) {
    if (!document) continue;
    const guide = translationGuideValue(document as Record<string, unknown>);
    if (guide !== undefined) validateTranslationGuide(guide);
    const profiles = illustrationProfilesValue(document as Record<string, unknown>);
    if (profiles !== undefined) validateIllustrationAppearanceProfiles(profiles);
  }
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

export function validateRisuContentSource(value: unknown): RisuContentSource {
  assertRisuContentSource(value);
  return structuredClone(value);
}
