export const MAX_FONT_BYTES = 20 * 1024 * 1024;
export const defaultAppFont = 'system-ui, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif';
export type FontFormat = 'woff2' | 'woff' | 'ttf' | 'otf';
export interface FontAsset {
  id: string;
  title: string;
  format: FontFormat;
  mimeType: string;
  byteLength: number;
  sourceUrl?: string;
  license?: string;
  createdAt: string;
}
export interface FontPreferences {
  revision: number;
  appFontId: string | null;
  readerFontId: string | null;
}
export interface FontCatalog {
  fonts: FontAsset[];
  preferences: FontPreferences;
}
export const fontFamily = (id: string) => `uimori-font-${id}`;
