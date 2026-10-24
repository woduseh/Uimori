import { DEFAULT_PALETTE_COLORS } from '../core/theme-palettes.js';

// Unspecified swatches use the same Radix palette as the initial app frame.
export const baselineThemeColors = DEFAULT_PALETTE_COLORS;
export function colorInputValue(value: string): string {
  if (value.length === 4 || value.length === 5)
    return '#' + [...value.slice(1, 4)].map((c) => c + c).join('');
  return value.slice(0, 7);
}
