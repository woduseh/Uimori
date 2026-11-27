import { z } from 'zod/v4';
import { defineOperation } from '../../endpoint.js';
import { revision } from '../revision.js';
import { nonBlank } from '../text.js';
import { MAX_THEME_ASSET_BYTES } from './endpoints.js';
import { storyUiStyles, THEME_COLOR_KEYS } from './theme-vocabulary.js';

export const fontId = nonBlank(64);
export const fontTitle = z.string().trim().min(1).max(200);

export const fontAsset = z.strictObject({
  id: z.string(),
  title: z.string(),
  format: z.enum(['woff2', 'woff', 'ttf', 'otf']),
  mimeType: z.string(),
  byteLength: z.int().nonnegative(),
  createdAt: z.string(),
});
export type FontAsset = z.infer<typeof fontAsset>;
export type FontFormat = FontAsset['format'];

export const fontPreferences = z.strictObject({
  revision,
  appFontId: z.string().nullable(),
  readerFontId: z.string().nullable(),
});
export type FontPreferences = z.infer<typeof fontPreferences>;

export const fontCatalog = z.strictObject({
  fonts: z.array(fontAsset),
  preferences: fontPreferences,
});
export type FontCatalog = z.infer<typeof fontCatalog>;

export const selectFontsInput = z.strictObject({
  expectedRevision: revision,
  appFontId: fontId.nullable(),
  readerFontId: fontId.nullable(),
});
export type SelectFonts = z.infer<typeof selectFontsInput>;

const fontOperations = {
  listFonts: defineOperation('appearance.listFonts', z.strictObject({}), fontCatalog),
  readFontPreferences: defineOperation(
    'appearance.readFontPreferences',
    z.strictObject({}),
    fontPreferences
  ),
  selectFonts: defineOperation('appearance.selectFonts', selectFontsInput, fontPreferences),
  uploadFont: defineOperation(
    'appearance.uploadFont',
    z.strictObject({ title: fontTitle, data: z.string() }),
    fontAsset
  ),
  deleteFont: defineOperation('appearance.deleteFont', z.strictObject({ id: fontId }), fontCatalog),
};

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const themeColors = z.partialRecord(z.enum(THEME_COLOR_KEYS), z.string());
const colorModes = z.strictObject({ light: themeColors, dark: themeColors });
const themeAssetKind = z.enum(['font', 'image']);
const themeAsset = z.strictObject({ name: z.string(), kind: themeAssetKind, hash: z.string() });
export const theme = z.strictObject({
  id: z.string(),
  revision,
  title: z.string(),
  description: z.string(),
  colors: colorModes,
  appCss: z.string(),
  messageCss: z.string(),
  templateHtml: z.string(),
  templateCss: z.string(),
  storyUi: z
    .strictObject({
      baseStyle: z.enum(storyUiStyles),
      css: z.string(),
      boardCss: z.string().optional(),
    })
    .optional(),
  assets: z.array(themeAsset).optional(),
});
const paletteText = { id: z.string(), title: z.string(), description: z.string() };
const completeColors = z.record(z.enum(THEME_COLOR_KEYS), z.string());
export const savedPalette = z.strictObject({ ...paletteText, revision, colors: colorModes });
export const palette = z.union([
  savedPalette,
  z.strictObject({
    ...paletteText,
    colors: z.strictObject({ light: completeColors, dark: completeColors }),
  }),
]);
export const themeBackground = z.strictObject({
  imageHash: sha256.nullable(),
  blur: z.int().min(0).max(30),
  lightOverlay: z.int().min(0).max(100),
  darkOverlay: z.int().min(0).max(100),
});
const idMap = z.record(z.string(), z.string());
const backgroundMap = z.record(z.string(), themeBackground);
export const themePreferences = z.strictObject({
  revision,
  defaultThemeId: z.string(),
  botThemes: idMap,
  chatThemes: idMap,
  botStoryUiThemes: idMap.optional(),
  defaultPaletteId: z.string().optional(),
  botPalettes: idMap.optional(),
  chatPalettes: idMap.optional(),
  defaultBackground: themeBackground.optional(),
  botBackgrounds: backgroundMap.optional(),
  chatBackgrounds: backgroundMap.optional(),
});
export const themeCatalog = z.strictObject({
  themes: z.array(theme),
  palettes: z.array(palette),
  preferences: themePreferences,
});

const selectionId = nonBlank(100);
const selectionScope = {
  scope: z.enum(['global', 'bot', 'chat']),
  targetId: selectionId.optional(),
  expectedRevision: revision,
};
const scopedTarget = (input: { scope: string; targetId?: string }) =>
  (input.scope === 'global') === (input.targetId === undefined);
const scopedTargetMessage = {
  message: 'A bot or chat choice names its target; a global choice names none',
  path: ['targetId'],
};
export const selectThemeInput = z
  .strictObject({
    ...selectionScope,
    dimension: z.enum(['theme', 'palette', 'storyUi']).default('theme'),
    themeId: selectionId.nullable().optional(),
    paletteId: selectionId.nullable().optional(),
  })
  .refine(scopedTarget, scopedTargetMessage)
  .refine(
    (input) =>
      input.dimension === 'palette'
        ? input.paletteId !== undefined && input.themeId === undefined
        : input.themeId !== undefined && input.paletteId === undefined,
    { message: 'Send paletteId for a palette choice and themeId otherwise', path: ['dimension'] }
  )
  .refine((input) => input.dimension !== 'storyUi' || input.scope === 'bot', {
    message: 'Story UI themes are chosen per bot',
    path: ['scope'],
  });
export type SelectThemeRequest = z.input<typeof selectThemeInput>;
export const selectThemeBackgroundInput = z
  .strictObject({ ...selectionScope, background: themeBackground.nullable() })
  .refine(scopedTarget, scopedTargetMessage);
export type SelectThemeBackground = z.infer<typeof selectThemeBackgroundInput>;

const resourceId = nonBlank(100);
export const storedThemeAsset = z.strictObject({
  hash: z.string(),
  kind: themeAssetKind,
  mime: z.string(),
  byteLength: z.int().nonnegative(),
});
export type StoredThemeAsset = z.infer<typeof storedThemeAsset>;

const themeOperations = {
  readThemes: defineOperation('appearance.readThemes', z.strictObject({}), themeCatalog),
  selectTheme: defineOperation('appearance.selectTheme', selectThemeInput, themePreferences),
  selectThemeBackground: defineOperation(
    'appearance.selectThemeBackground',
    selectThemeBackgroundInput,
    themePreferences
  ),
  deleteTheme: defineOperation(
    'appearance.deleteTheme',
    z.strictObject({ id: resourceId, expectedRevision: revision }),
    z.strictObject({ deleted: z.string() })
  ),
  listPalettes: defineOperation(
    'appearance.listPalettes',
    z.strictObject({}),
    z.strictObject({ palettes: z.array(palette) })
  ),
  createPalette: defineOperation(
    'appearance.createPalette',
    z.strictObject({ model: z.unknown() }),
    savedPalette
  ),
  updatePalette: defineOperation(
    'appearance.updatePalette',
    z.strictObject({ id: resourceId, model: z.unknown(), expectedRevision: revision }),
    savedPalette
  ),
  deletePalette: defineOperation(
    'appearance.deletePalette',
    z.strictObject({ id: resourceId, expectedRevision: revision }),
    z.strictObject({ deleted: z.string() })
  ),
  uploadThemeAsset: defineOperation(
    'appearance.uploadThemeAsset',
    z.strictObject({
      kind: themeAssetKind,
      data: z.string().max(Math.ceil(MAX_THEME_ASSET_BYTES / 3) * 4),
    }),
    storedThemeAsset
  ),
};

export const appearanceOperations = { ...fontOperations, ...themeOperations };
