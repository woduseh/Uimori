/** Presentation resources only. Never include these in a model request or story snapshot. */
export const THEME_COLOR_KEYS = [
  'bg',
  'nav',
  'panel',
  'surface',
  'surface-raised',
  'hover',
  'line',
  'input-border',
  'text',
  'muted',
  'faint',
  'accent',
  'accent-ink',
  'accent-soft',
  'user',
  'error',
  'error-ink',
  'error-bg',
  'shade',
] as const;
export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];
export type ThemeColors = Partial<Record<ThemeColorKey, string>>;
export type ThemeDefinition = {
  title: string;
  description: string;
  colors: { light: ThemeColors; dark: ThemeColors };
  appCss: string;
  messageCss: string;
  templateHtml: string;
  templateCss: string;
};
export type Theme = ThemeDefinition & { id: string; revision: number };
export type ThemePreferences = {
  revision: number;
  defaultThemeId: string;
  botThemes: Record<string, string>;
  chatThemes: Record<string, string>;
};
export type ThemeCatalog = { themes: Theme[]; preferences: ThemePreferences };
export type ThemeScope = { botId?: string; chatId?: string };
export const DEFAULT_THEME_ID = 'builtin:forest';
export const THEME_FILE_FORMAT = 'uimori-theme';
export const DEFAULT_THEME_TEMPLATE =
  '<slot name="request"></slot><slot name="heading"></slot><slot name="body"></slot><slot name="actions"></slot><slot></slot>';
export const THEME_SLOTS = ['request', 'heading', 'body', 'actions'] as const;
export function emptyTheme(title = '새 테마'): ThemeDefinition {
  return {
    title,
    description: '',
    colors: { light: {}, dark: {} },
    appCss: '',
    messageCss: '',
    templateHtml: '',
    templateCss: '',
  };
}
export function defaultThemePreferences(): ThemePreferences {
  return { revision: 0, defaultThemeId: DEFAULT_THEME_ID, botThemes: {}, chatThemes: {} };
}
function palette(
  bg: string,
  nav: string,
  panel: string,
  surface: string,
  line: string,
  text: string,
  muted: string,
  accent: string,
  ink: string
): ThemeColors {
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
  };
}
export const BUILTIN_THEMES: Theme[] = [
  {
    ...emptyTheme('숲'),
    id: DEFAULT_THEME_ID,
    revision: 1,
    description: '익숙한 Uimori의 차분한 초록빛',
  },
  {
    ...emptyTheme('서재'),
    id: 'builtin:library',
    revision: 1,
    description: '따뜻한 종이와 잉크의 온기',
    colors: {
      light: palette(
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
      dark: palette(
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
    templateHtml:
      '<slot name="request"></slot><section class="paper"><header><slot name="heading"></slot></header><slot name="body"></slot><footer><slot name="actions"></slot></footer></section>',
    templateCss:
      '.paper { border: 1px solid var(--line); border-radius: 14px; padding: clamp(14px, 3vw, 30px); background: var(--panel); } header { border-bottom: 1px solid var(--line); margin-bottom: 20px; } footer { margin-top: 16px; }',
  },
  {
    ...emptyTheme('미드나이트'),
    id: 'builtin:midnight',
    revision: 1,
    description: '청회색 바탕과 선명한 푸른 포인트',
    colors: {
      light: palette(
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
      dark: palette(
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
    ...emptyTheme('벚꽃'),
    id: 'builtin:blossom',
    revision: 1,
    description: '절제된 분홍빛과 부드러운 대비',
    colors: {
      light: palette(
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
      dark: palette(
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
];
export function themeDefinition(theme: Theme): ThemeDefinition {
  const { id: _id, revision: _revision, ...definition } = theme;
  return definition;
}
export function resolveTheme(catalog: ThemeCatalog, scope: ThemeScope): Theme {
  const { preferences: p, themes } = catalog;
  for (const id of [
    scope.chatId && p.chatThemes[scope.chatId],
    scope.botId && p.botThemes[scope.botId],
    p.defaultThemeId,
    DEFAULT_THEME_ID,
  ]) {
    const theme = id && themes.find((item) => item.id === id);
    if (theme) return theme;
  }
  return BUILTIN_THEMES[0];
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label}: 객체가 필요해요.`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string, limit: number, fallback = ''): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > limit)
    throw new Error(`${label}: 최대 ${limit.toLocaleString()}자의 문자열을 입력해 주세요.`);
  return value;
}
export function validateTheme(value: unknown): ThemeDefinition {
  const v = object(value, '테마');
  const title = string(v.title, '테마 이름', 100).trim();
  if (!title) throw new Error('테마 이름을 입력해 주세요.');
  const colorInput = v.colors === undefined ? {} : object(v.colors, '색상');
  const colors: ThemeDefinition['colors'] = { light: {}, dark: {} };
  for (const mode of ['light', 'dark'] as const) {
    const entries = colorInput[mode] === undefined ? {} : object(colorInput[mode], '색상');
    for (const [key, color] of Object.entries(entries)) {
      if (!THEME_COLOR_KEYS.includes(key as ThemeColorKey))
        throw new Error(`지원하지 않는 색상 변수: ${key}`);
      if (typeof color !== 'string' || !/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(color))
        throw new Error(`${key}: #RRGGBB 형식의 색상을 입력해 주세요.`);
      colors[mode][key as ThemeColorKey] = color;
    }
  }
  return {
    title,
    description: string(v.description, '설명', 2000),
    colors,
    appCss: string(v.appCss, '앱 CSS', 1_000_000),
    messageCss: string(v.messageCss, '본문 CSS', 1_000_000),
    templateHtml: string(v.templateHtml, '레이아웃 HTML', 100_000),
    templateCss: string(v.templateCss, '레이아웃 CSS', 1_000_000),
  };
}
export function parseThemeFile(value: unknown): ThemeDefinition {
  const file = object(value, '테마 파일');
  if (file.format !== THEME_FILE_FORMAT || file.version !== 1)
    throw new Error('Uimori 테마 v1 파일이 아니에요. Risu 테마의 자동 변환은 지원하지 않아요.');
  return validateTheme(file.theme);
}
export function themeFile(theme: ThemeDefinition) {
  return { format: THEME_FILE_FORMAT, version: 1, theme: validateTheme(theme) };
}
