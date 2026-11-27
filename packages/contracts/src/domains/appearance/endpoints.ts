import { defineEndpoint } from '../../endpoint.js';
import type { appearanceOperations as operations } from './operations.js';

export const MAX_FONT_BYTES = 20 * 1024 * 1024;

export const appearanceEndpoints = {
  listFonts: defineEndpoint<typeof operations.listFonts>({
    operation: 'appearance.listFonts',
    method: 'GET',
    path: '/fonts',
  }),
  readFontPreferences: defineEndpoint<typeof operations.readFontPreferences>({
    operation: 'appearance.readFontPreferences',
    method: 'GET',
    path: '/font-preferences',
  }),
  selectFonts: defineEndpoint<typeof operations.selectFonts>({
    operation: 'appearance.selectFonts',
    method: 'PUT',
    path: '/font-preferences',
  }),
  uploadFont: defineEndpoint<typeof operations.uploadFont>({
    operation: 'appearance.uploadFont',
    method: 'POST',
    path: '/fonts',
    bodyLimit: Math.ceil(MAX_FONT_BYTES / 3) * 4 + 10_000,
  }),
  deleteFont: defineEndpoint<typeof operations.deleteFont>({
    operation: 'appearance.deleteFont',
    method: 'DELETE',
    path: '/fonts/:id',
  }),
};
