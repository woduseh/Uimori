import type { ThemeAssetKind } from './themes.js';

/** Files under third_party/theme-assets, identified by the SHA-256 of their bytes. */
export type BuiltinThemeAssetFile = {
  hash: string;
  kind: ThemeAssetKind;
  mime: string;
  file: string;
};

export const BUILTIN_THEME_ASSET_FILES: BuiltinThemeAssetFile[] = [
  {
    hash: '986f916aa79819fee1026278633959af70d333c108d00aca63f144f7133dc5fd',
    kind: 'font',
    mime: 'font/woff2',
    file: 'GowunBatang-Regular.woff2',
  },
  {
    hash: 'c969373f338978373f8475da7c912329a7f2d4b26f0bf44a274d2a5bc93de4c3',
    kind: 'font',
    mime: 'font/woff2',
    file: 'NanumPenScript-Regular.woff2',
  },
  {
    hash: '4f3a72b85a8fbfb86be0ccc146b6a1fc8055ccb9e5d41adf1201e8840e161444',
    kind: 'image',
    mime: 'image/webp',
    file: 'letter-corner.webp',
  },
  {
    hash: 'eb012f9ac3035cf23ff53e331316fca91c602efd647a0d82fe5a228d2c4664d8',
    kind: 'image',
    mime: 'image/webp',
    file: 'letter-divider.webp',
  },
  {
    hash: 'ca06092f05c8578d89e2eaf5eedb393870663e3850147685433c28193413c569',
    kind: 'image',
    mime: 'image/webp',
    file: 'scrap-torn.webp',
  },
  {
    hash: '0f105fa3cfdf87262c29ba69567b9638c1f93f7268ca1817f1c114576e823a5c',
    kind: 'image',
    mime: 'image/webp',
    file: 'scrap-sprig.webp',
  },
  {
    hash: '66281a51e87708405727b34fdc160eeff2e25e4982159727f793d3f6ff39be57',
    kind: 'image',
    mime: 'image/webp',
    file: 'cinema-corner.webp',
  },
  {
    hash: '1062c7e4be2a02b8c13169c6476dea15814064307b684318f4fd4ceac532ca2a',
    kind: 'image',
    mime: 'image/webp',
    file: 'cinema-wing.webp',
  },
];

export function builtinThemeAsset(name: string, file: string) {
  const entry = BUILTIN_THEME_ASSET_FILES.find((item) => item.file === file)!;
  return { name, kind: entry.kind, hash: entry.hash };
}
