import type { ThemeColorKey } from './themes.js';

/** The explicit theme-owned palette stops inheritance; null in the API means inherit. */
export const THEME_PALETTE_ID = 'theme';
export type PaletteColors = Record<ThemeColorKey, string>;
export type ThemePalette = {
  id: string;
  title: string;
  description: string;
  colors: { light: PaletteColors; dark: PaletteColors };
};

function colors(
  mode: 'light' | 'dark',
  bg: string,
  nav: string,
  panel: string,
  surface: string,
  line: string,
  text: string,
  muted: string,
  accent: string,
  ink: string
): PaletteColors {
  return {
    bg,
    nav,
    panel,
    surface,
    'surface-raised': panel,
    hover: surface,
    line,
    'input-border': muted,
    text,
    muted,
    faint: muted,
    accent,
    'accent-ink': ink,
    'accent-soft': surface,
    user: surface,
    error: mode === 'light' ? '#9d3022' : '#f3b3a9',
    'error-ink': mode === 'light' ? '#ffffff' : '#3d1a14',
    'error-bg': mode === 'light' ? '#fcf0ed' : '#372726',
    shade: mode === 'light' ? '#14201459' : '#00000088',
  };
}

/** Complete palettes can color any layout without inheriting another layout's colors. */
export const BUILTIN_PALETTES: ThemePalette[] = [
  {
    id: 'forest',
    title: '숲',
    description: '익숙한 Uimori의 차분한 초록빛',
    colors: {
      light: {
        ...colors(
          'light',
          '#fafbf8',
          '#f0f2ec',
          '#ffffff',
          '#e9ede5',
          '#cbd3c4',
          '#232c22',
          '#586451',
          '#355b39',
          '#ffffff'
        ),
        'surface-raised': '#f3f5ef',
        hover: '#e0e7da',
        'input-border': '#76836e',
        faint: '#66735f',
        'accent-soft': '#e0e9db',
        user: '#edf1e8',
      },
      dark: {
        ...colors(
          'dark',
          '#1a1d1b',
          '#141715',
          '#222623',
          '#292e2a',
          '#394039',
          '#eef1eb',
          '#adb6aa',
          '#bdd4b7',
          '#20341e'
        ),
        hover: '#303831',
        'input-border': '#74816f',
        faint: '#9ba694',
        'accent-soft': '#303b30',
        user: '#2a312b',
      },
    },
  },
  {
    id: 'cream',
    title: '크림',
    description: '따뜻한 종이와 잉크의 온기',
    colors: {
      light: colors(
        'light',
        '#f6f1e7',
        '#eee5d5',
        '#fffaf1',
        '#eadecc',
        '#d2c3ad',
        '#382e24',
        '#736453',
        '#785137',
        '#ffffff'
      ),
      dark: colors(
        'dark',
        '#211d19',
        '#191613',
        '#2b2520',
        '#393026',
        '#524638',
        '#ede1cf',
        '#bdae98',
        '#dcb98b',
        '#2b2015'
      ),
    },
  },
  {
    id: 'charcoal',
    title: '차콜',
    description: '중립적인 회색과 또렷한 활자',
    colors: {
      light: colors(
        'light',
        '#f4f4f3',
        '#e9e9e7',
        '#ffffff',
        '#e2e2df',
        '#c8c8c4',
        '#292928',
        '#636360',
        '#454541',
        '#ffffff'
      ),
      dark: colors(
        'dark',
        '#191a1b',
        '#121314',
        '#242527',
        '#303235',
        '#484b50',
        '#ededec',
        '#b1b3b6',
        '#d3d4d5',
        '#232426'
      ),
    },
  },
  {
    id: 'midnight',
    title: '미드나이트',
    description: '청회색 바탕과 선명한 푸른 포인트',
    colors: {
      light: colors(
        'light',
        '#f3f6fb',
        '#e8edf6',
        '#ffffff',
        '#e3eaf6',
        '#c6d2e6',
        '#22314b',
        '#556a88',
        '#305d9e',
        '#ffffff'
      ),
      dark: colors(
        'dark',
        '#131923',
        '#0e131c',
        '#1b2433',
        '#26344a',
        '#35455f',
        '#e7eefb',
        '#a6b7d0',
        '#a5c6ff',
        '#172940'
      ),
    },
  },
  {
    id: 'rose',
    title: '로즈',
    description: '절제된 분홍빛과 부드러운 대비',
    colors: {
      light: colors(
        'light',
        '#fcf5f7',
        '#f3e7ed',
        '#fffafd',
        '#f1dfe7',
        '#dbc4cf',
        '#422d39',
        '#826373',
        '#934a6c',
        '#ffffff'
      ),
      dark: colors(
        'dark',
        '#241b22',
        '#1c151b',
        '#30242d',
        '#42303e',
        '#5b4152',
        '#f3e3ee',
        '#c1a5b6',
        '#e7b0cc',
        '#3a1c2f'
      ),
    },
  },
  {
    id: 'sage',
    title: '세이지',
    description: '옅은 허브빛과 고요한 청록 포인트',
    colors: {
      light: colors(
        'light',
        '#f3f6f0',
        '#e5ece1',
        '#fbfdf8',
        '#e0e9dc',
        '#bdcdb8',
        '#26372d',
        '#5b7062',
        '#3c6957',
        '#ffffff'
      ),
      dark: colors(
        'dark',
        '#19231f',
        '#121b17',
        '#222f28',
        '#2f4036',
        '#465c4d',
        '#e6efe4',
        '#aec3ae',
        '#b5d4b0',
        '#233a28'
      ),
    },
  },
];

export function isPaletteId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    (id === THEME_PALETTE_ID || BUILTIN_PALETTES.some((palette) => palette.id === id))
  );
}
