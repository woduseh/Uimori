import type { ThemeColorKey, ThemeColors } from './themes.js';
import { RADIX_COLOR_SCALES } from './radix-colors.js';

/** The explicit theme-owned palette stops inheritance; null in the API means inherit. */
export const THEME_PALETTE_ID = 'theme';
export type PaletteColors = Record<ThemeColorKey, string>;
export type ThemePalette = {
  id: string;
  title: string;
  description: string;
  colors: { light: PaletteColors; dark: PaletteColors };
};

type NeutralScale = 'gray' | 'mauve' | 'slate' | 'sage' | 'olive' | 'sand';
type AccentScale = 'gray' | 'grass' | 'jade' | 'bronze' | 'crimson' | 'indigo';

function colors(
  mode: 'light' | 'dark',
  neutralName: NeutralScale,
  accentName: AccentScale
): PaletteColors {
  const scales = RADIX_COLOR_SCALES[mode];
  const neutral = scales[neutralName];
  const accent = scales[accentName];
  const { red, jade, amber, blue } = scales;
  // Dark gray/indigo step 10 needs a different foreground than step 9 for AA text contrast.
  const ink =
    accentName === 'indigo' || (accentName === 'gray' && mode === 'dark') ? '#ffffff' : '#000000';
  return {
    bg: neutral[1],
    nav: neutral[2],
    panel: neutral[2],
    surface: neutral[3],
    'surface-raised': neutral[3],
    'surface-active': neutral[5],
    hover: neutral[4],
    line: neutral[6],
    'input-border': neutral[8],
    'border-hover': neutral[8],
    'focus-ring': accent[11],
    text: neutral[12],
    muted: neutral[11],
    faint: neutral[11],
    accent: accent[9],
    'accent-ink': ink,
    'accent-hover': accent[10],
    'accent-hover-ink': accentName === 'indigo' && mode === 'light' ? '#ffffff' : '#000000',
    // Jade 11 on sage 2 falls just below AA for the app's small text.
    'accent-text': accentName === 'jade' && mode === 'light' ? accent[12] : accent[11],
    'accent-line': accent[7],
    'accent-soft': mode === 'light' ? accent[3] : accent[4],
    user: accent[3],
    error: red[11],
    'error-ink': '#000000',
    'error-bg': red[3],
    'error-line': red[7],
    'error-solid': red[9],
    'error-hover': red[10],
    success: jade[11],
    'success-bg': jade[3],
    'success-line': jade[7],
    warning: amber[11],
    'warning-bg': amber[3],
    'warning-line': amber[7],
    info: blue[11],
    'info-bg': blue[3],
    'info-line': blue[7],
    // Radix blackA8 / blackA9 overlays are independent of color mode.
    shade: mode === 'light' ? '#00000099' : '#000000b3',
  };
}

function palette(
  id: string,
  title: string,
  description: string,
  neutral: NeutralScale,
  accent: AccentScale
): ThemePalette {
  return {
    id,
    title,
    description,
    colors: { light: colors('light', neutral, accent), dark: colors('dark', neutral, accent) },
  };
}

/** Stable selection IDs; only built-in presentation colors change, never authored themes. */
export const BUILTIN_PALETTES: ThemePalette[] = [
  palette('forest', '숲', '익숙한 Uimori의 차분한 초록빛', 'olive', 'grass'),
  palette('cream', '크림', '따뜻한 종이와 잉크의 온기', 'sand', 'bronze'),
  palette('charcoal', '차콜', '중립적인 회색과 또렷한 활자', 'gray', 'gray'),
  palette('midnight', '미드나이트', '청회색 바탕과 선명한 푸른 포인트', 'slate', 'indigo'),
  palette('rose', '로즈', '절제된 분홍빛과 부드러운 대비', 'mauve', 'crimson'),
  palette('sage', '세이지', '옅은 허브빛과 고요한 청록 포인트', 'sage', 'jade'),
];

/** Halo cream and blue-black ink belong to the default layout, not a named selection. */
export const DEFAULT_PALETTE_COLORS: ThemePalette['colors'] = {
  light: {
    ...colors('light', 'slate', 'bronze'),
    bg: '#fffaf3',
    nav: '#f7f0e7',
    panel: '#f7f0e7',
    surface: '#eee8e2',
    'surface-raised': '#eee8e2',
    'surface-active': '#ded6d1',
    hover: '#e8e1dc',
    line: '#d7d0cb',
    'input-border': '#aaa3a3',
    'border-hover': '#8d8792',
    'focus-ring': '#555065',
    text: '#252632',
    muted: '#62616c',
    faint: '#62616c',
    accent: '#343746',
    'accent-ink': '#ffe5c8',
    'accent-hover': '#45495c',
    'accent-hover-ink': '#ffe5c8',
    'accent-text': '#555065',
    'accent-line': '#bcb0a7',
    'accent-soft': '#f0e4d8',
    user: '#f0e4d8',
  },
  dark: {
    ...colors('dark', 'slate', 'bronze'),
    bg: '#14141b',
    nav: '#1a1b24',
    panel: '#1e202b',
    surface: '#272936',
    'surface-raised': '#272936',
    'surface-active': '#393c4c',
    hover: '#303341',
    line: '#414453',
    'input-border': '#65697f',
    'border-hover': '#82869b',
    'focus-ring': '#ffe5c8',
    text: '#f2eee8',
    muted: '#b4b6c6',
    faint: '#b4b6c6',
    accent: '#ffe5c8',
    'accent-ink': '#242632',
    'accent-hover': '#fff0dd',
    'accent-hover-ink': '#242632',
    'accent-text': '#ffe5c8',
    'accent-line': '#736455',
    'accent-soft': '#39333a',
    user: '#292730',
  },
};

export function isPaletteId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    (id === THEME_PALETTE_ID || BUILTIN_PALETTES.some((palette) => palette.id === id))
  );
}

export type PaletteDefinition = {
  title: string;
  description: string;
  colors: { light: ThemeColors; dark: ThemeColors };
};
export type Palette = PaletteDefinition & { id: string; revision: number };
