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

/** Warm paper and quiet charcoal frame the halo cream; named selections remain independent. */
export const DEFAULT_PALETTE_COLORS: ThemePalette['colors'] = {
  light: {
    ...colors('light', 'slate', 'bronze'),
    bg: '#f2f0eb',
    nav: '#f8f7f4',
    panel: '#f8f7f4',
    surface: '#e5e3df',
    'surface-raised': '#e1dfda',
    'surface-active': '#d9d7d2',
    hover: '#dfddd8',
    line: '#d3d1cd',
    'input-border': '#999794',
    'border-hover': '#878683',
    'focus-ring': '#73572f',
    text: '#302f2d',
    muted: '#62615e',
    faint: '#62615e',
    accent: '#73572f',
    'accent-ink': '#ffe5c8',
    'accent-hover': '#684e2a',
    'accent-hover-ink': '#ffe5c8',
    'accent-text': '#73572f',
    'accent-line': '#bdb09c',
    'accent-soft': '#e5e1d8',
    user: '#e8e4dc',
  },
  dark: {
    ...colors('dark', 'slate', 'bronze'),
    bg: '#1d1f22',
    nav: '#242528',
    panel: '#242528',
    surface: '#292b2d',
    'surface-raised': '#2e3032',
    'surface-active': '#363739',
    hover: '#303133',
    line: '#3b3c3e',
    'input-border': '#747472',
    'border-hover': '#858482',
    'focus-ring': '#ffe5c8',
    text: '#dad7d0',
    muted: '#adaba6',
    faint: '#adaba6',
    accent: '#ffe5c8',
    'accent-ink': '#171b20',
    'accent-hover': '#fff0dd',
    'accent-hover-ink': '#171b20',
    'accent-text': '#ffe5c8',
    'accent-line': '#645a48',
    'accent-soft': '#2e2d2b',
    user: '#2b2a29',
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
