import { defineEndpoint } from '../../endpoint.js';
import { IMAGE_INPUT_MAX_BYTES } from '../../image-limits.js';
import type { appearanceOperations as operations } from './operations.js';

export const MAX_FONT_BYTES = 20 * 1024 * 1024;
export const MAX_THEME_ASSET_BYTES = Math.max(MAX_FONT_BYTES, IMAGE_INPUT_MAX_BYTES);
const base64Bytes = (bytes: number) => Math.ceil(bytes / 3) * 4;

export const appearanceEndpoints = {
  listFonts: defineEndpoint<typeof operations.listFonts>()({
    operation: 'appearance.listFonts',
    method: 'GET',
    path: '/fonts',
    cache: 'revalidate',
  }),
  readFontPreferences: defineEndpoint<typeof operations.readFontPreferences>()({
    operation: 'appearance.readFontPreferences',
    method: 'GET',
    path: '/font-preferences',
  }),
  selectFonts: defineEndpoint<typeof operations.selectFonts>()({
    operation: 'appearance.selectFonts',
    method: 'PUT',
    path: '/font-preferences',
  }),
  uploadFont: defineEndpoint<typeof operations.uploadFont>()({
    operation: 'appearance.uploadFont',
    method: 'POST',
    path: '/fonts',
    bodyLimit: base64Bytes(MAX_FONT_BYTES) + 10_000,
  }),
  deleteFont: defineEndpoint<typeof operations.deleteFont>()({
    operation: 'appearance.deleteFont',
    method: 'DELETE',
    path: '/fonts/:id',
  }),
  readThemes: defineEndpoint<typeof operations.readThemes>()({
    operation: 'appearance.readThemes',
    method: 'GET',
    path: '/themes',
  }),
  selectTheme: defineEndpoint<typeof operations.selectTheme>()({
    operation: 'appearance.selectTheme',
    method: 'POST',
    path: '/themes/selection',
  }),
  selectThemeBackground: defineEndpoint<typeof operations.selectThemeBackground>()({
    operation: 'appearance.selectThemeBackground',
    method: 'POST',
    path: '/themes/background',
  }),
  deleteTheme: defineEndpoint<typeof operations.deleteTheme>()({
    operation: 'appearance.deleteTheme',
    method: 'DELETE',
    path: '/themes/:id',
  }),
  listPalettes: defineEndpoint<typeof operations.listPalettes>()({
    operation: 'appearance.listPalettes',
    method: 'GET',
    path: '/palettes',
  }),
  createPalette: defineEndpoint<typeof operations.createPalette>()({
    operation: 'appearance.createPalette',
    method: 'POST',
    path: '/palettes',
  }),
  updatePalette: defineEndpoint<typeof operations.updatePalette>()({
    operation: 'appearance.updatePalette',
    method: 'PUT',
    path: '/palettes/:id',
  }),
  deletePalette: defineEndpoint<typeof operations.deletePalette>()({
    operation: 'appearance.deletePalette',
    method: 'DELETE',
    path: '/palettes/:id',
  }),
  uploadThemeAsset: defineEndpoint<typeof operations.uploadThemeAsset>()({
    operation: 'appearance.uploadThemeAsset',
    method: 'POST',
    path: '/theme-assets',
    bodyLimit: base64Bytes(MAX_THEME_ASSET_BYTES) + 10_000,
  }),
};
