import { validateTheme } from './themes.js';
import type { PaletteDefinition } from './theme-palettes.js';
import { ValidationError } from './validation-error.js';

export const PALETTE_FILE_FORMAT = 'uimori-palette';
export function validatePalette(value: unknown): PaletteDefinition {
  const { title, description, colors } = validateTheme(value);
  return { title, description, colors };
}
export function parsePaletteFile(value: unknown): PaletteDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ValidationError(400, 'PALETTE_FILE_INVALID', 'Expected a palette file object.');
  const file = value as Record<string, unknown>;
  if (file.format !== PALETTE_FILE_FORMAT || file.version !== 1)
    throw new ValidationError(
      400,
      'PALETTE_FILE_UNSUPPORTED',
      `Expected format "${PALETTE_FILE_FORMAT}" with version 1.`
    );
  return validatePalette(file.palette);
}
export function paletteFile(palette: PaletteDefinition) {
  return { format: PALETTE_FILE_FORMAT, version: 1, palette: validatePalette(palette) };
}
