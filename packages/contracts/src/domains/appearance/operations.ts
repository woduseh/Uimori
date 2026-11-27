import { z } from 'zod/v4';
import { defineOperation } from '../../endpoint.js';
import { revision } from '../revision.js';

export const fontId = z.string().min(1).max(64);
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

export const appearanceOperations = {
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
