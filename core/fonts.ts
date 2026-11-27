export { MAX_FONT_BYTES } from '#contracts';
export type { FontAsset, FontCatalog, FontFormat, FontPreferences } from '#contracts';
export const defaultAppFont = 'system-ui, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif';
export const fontFamily = (id: string) => `uimori-font-${id}`;
