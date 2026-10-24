import { validateTheme } from './themes.js';
import type { PaletteDefinition } from './theme-palettes.js';

export const PALETTE_FILE_FORMAT = 'uimori-palette';
export function validatePalette(value: unknown): PaletteDefinition {
  const { title, description, colors } = validateTheme(value);
  return { title, description, colors };
}
export function parsePaletteFile(value: unknown): PaletteDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('팔레트 파일을 확인해 주세요.');
  const file = value as Record<string, unknown>;
  if (file.format !== PALETTE_FILE_FORMAT || file.version !== 1)
    throw new Error('Uimori 팔레트 v1 파일이 아니에요.');
  return validatePalette(file.palette);
}
export function paletteFile(palette: PaletteDefinition) {
  return { format: PALETTE_FILE_FORMAT, version: 1, palette: validatePalette(palette) };
}
