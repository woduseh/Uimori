import type { ThemeBackground } from './theme-background.js';
import {
  cinematicTheme,
  letterTheme,
  scrapbookTheme,
  classicFrameTheme,
} from './narrative-themes.js';
import {
  BUILTIN_PALETTES,
  DEFAULT_PALETTE_COLORS,
  THEME_PALETTE_ID,
  isPaletteId,
} from './theme-palettes.js';

/** Presentation resources only. Never include these in a model request or story snapshot. */
export const THEME_COLOR_KEYS = [
  'bg',
  'nav',
  'panel',
  'surface',
  'surface-raised',
  'surface-active',
  'hover',
  'line',
  'input-border',
  'border-hover',
  'focus-ring',
  'text',
  'muted',
  'faint',
  'accent',
  'accent-ink',
  'accent-hover',
  'accent-hover-ink',
  'accent-text',
  'accent-line',
  'accent-soft',
  'user',
  'error',
  'error-ink',
  'error-bg',
  'error-line',
  'error-solid',
  'error-hover',
  'success',
  'success-bg',
  'success-line',
  'warning',
  'warning-bg',
  'warning-line',
  'info',
  'info-bg',
  'info-line',
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
  /** Missing scoped selections inherit; 'theme' explicitly uses the layout's saved colors. */
  defaultPaletteId?: string;
  botPalettes?: Record<string, string>;
  chatPalettes?: Record<string, string>;
  defaultBackground?: ThemeBackground;
  botBackgrounds?: Record<string, ThemeBackground>;
  chatBackgrounds?: Record<string, ThemeBackground>;
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
  return {
    revision: 0,
    defaultThemeId: DEFAULT_THEME_ID,
    botThemes: {},
    chatThemes: {},
    defaultPaletteId: THEME_PALETTE_ID,
    botPalettes: {},
    chatPalettes: {},
  };
}
const originalBuiltinThemes: Theme[] = [
  {
    ...emptyTheme('숲'),
    id: DEFAULT_THEME_ID,
    revision: 1,
    description: '익숙한 Uimori의 차분한 초록빛',
    colors: DEFAULT_PALETTE_COLORS,
  },
  {
    ...emptyTheme('서재'),
    id: 'builtin:library',
    revision: 1,
    description: '따뜻한 종이와 잉크의 온기',
    colors: BUILTIN_PALETTES.find((item) => item.id === 'cream')!.colors,
    templateHtml:
      '<slot name="request"></slot><section class="paper"><header><slot name="heading"></slot></header><slot name="body"></slot><footer><slot name="actions"></slot></footer></section>',
    templateCss:
      '.paper { border: var(--hairline) solid var(--line); border-radius: var(--radius-panel); padding: clamp(14px, 3vw, 30px); background: var(--panel); } header { border-bottom: var(--hairline) solid var(--line); margin-bottom: 20px; } footer { margin-top: 16px; }',
  },
  {
    ...emptyTheme('미드나이트'),
    id: 'builtin:midnight',
    revision: 1,
    description: '청회색 바탕과 선명한 푸른 포인트',
    colors: BUILTIN_PALETTES.find((item) => item.id === 'midnight')!.colors,
  },
  {
    ...emptyTheme('벚꽃'),
    id: 'builtin:blossom',
    revision: 1,
    description: '절제된 분홍빛과 부드러운 대비',
    colors: BUILTIN_PALETTES.find((item) => item.id === 'rose')!.colors,
  },
];
/**
 * Palette-only presets share the default layout. The former library's distinct paper
 * structure remains readable/exportable for existing selections, but is not a picker preset.
 */
export const LEGACY_BUILTIN_THEMES = originalBuiltinThemes.slice(1);
export const BUILTIN_THEMES: Theme[] = [
  {
    ...originalBuiltinThemes[0],
    title: '기본',
    revision: 4,
    description: '군더더기 없는 기본 읽기 레이아웃',
    templateHtml:
      '<div class="request-row"><slot name="request"></slot><aside class="request-persona"><slot name="request-persona"></slot></aside></div><slot name="heading"></slot><slot name="body"></slot><slot name="actions"></slot>',
    templateCss:
      '.request-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:16px; align-items:start; } :host([data-has-request-persona="false"]) .request-persona { display:none; } @media(max-width:760px) { .request-row { display:flex; flex-direction:column; gap:8px; align-items:stretch; } .request-persona { order:-1; align-self:flex-end; } }',
    appCss: `
.reader > .story-context { display:flex; gap:12px; margin-bottom:28px; align-items:center; }
.reader .reader-bot-avatar, .request-portraits .reader-portrait-button { width:72px; height:72px; border-radius:50%; flex-shrink:0; }
.reader .reader-bot-avatar .profile-asset, .reader .reader-bot-avatar .content-avatar, .request-portraits .reader-portrait-button img { width:100%; height:100%; border-radius:50%; object-fit:cover; object-position:center 20%; --content-avatar-size:72px; }
.reader .reader-bot-avatar img { object-position:center 20%; }
.reader .story-context > strong { display:block; font-size:var(--font-body); color:var(--text); font-weight:500; }
.request-portraits { display:block; width:auto; max-width:200px; }
.request-portraits .reader-gallery-heading, .request-portraits .reader-gallery-caption, .request-portraits figcaption small { display:none; }
.request-portraits [data-uimori-part="persona-portrait"] { display:flex; align-items:center; gap:12px; }
.request-portraits .reader-portrait-empty { min-height:72px; font-size:var(--font-heading); }
.request-portraits figcaption { font-size:var(--font-body); color:var(--text); padding:0; text-align:left; overflow-wrap:anywhere; }
.request-portraits figcaption strong { font-weight:500; }
@media(max-width:760px) { .reader .reader-bot-avatar, .request-portraits .reader-portrait-button { width:60px; height:60px; } .reader .reader-bot-avatar .content-avatar { --content-avatar-size:60px; } .request-portraits .reader-portrait-empty { min-height:60px; } }

`,
  },
  { ...cinematicTheme, id: 'builtin:cinematic', revision: 4 },
  { ...letterTheme, id: 'builtin:letter', revision: 4 },
  { ...scrapbookTheme, id: 'builtin:scrapbook', revision: 4 },
  { ...classicFrameTheme, id: 'builtin:classic-frame', revision: 3 },
];
export function getBuiltinTheme(id: string): Theme | undefined {
  const currentId = id === 'builtin:liquid-gallery' ? 'builtin:cinematic' : id;
  return [...BUILTIN_THEMES, ...LEGACY_BUILTIN_THEMES].find((theme) => theme.id === currentId);
}
export function themeDefinition(theme: Theme): ThemeDefinition {
  const { id: _id, revision: _revision, ...definition } = theme;
  return definition;
}

/**
 * Upgrade choices in memory, without deleting or rewriting any saved theme resource.
 * Old coupled choices establish color boundaries at each explicitly selected scope.
 * Once a preference write occurs the independent palette fields make this idempotent.
 */
export function normalizeThemePreferences(value: ThemePreferences): ThemePreferences {
  const legacy = !(
    'defaultPaletteId' in value ||
    'botPalettes' in value ||
    'chatPalettes' in value
  );
  const p: ThemePreferences = {
    ...value,
    botThemes: { ...value.botThemes },
    chatThemes: { ...value.chatThemes },
    botPalettes: { ...value.botPalettes },
    chatPalettes: { ...value.chatPalettes },
  };
  const migrate = (id: string, paletteId: string | undefined): [string, string | undefined] => {
    if (id === 'builtin:liquid-gallery')
      return ['builtin:cinematic', paletteId ?? (legacy ? THEME_PALETTE_ID : undefined)];
    if (id === 'builtin:midnight' || id === 'builtin:blossom')
      return [DEFAULT_THEME_ID, paletteId ?? (id === 'builtin:midnight' ? 'midnight' : 'rose')];
    return [id, paletteId ?? (legacy ? THEME_PALETTE_ID : undefined)];
  };
  [p.defaultThemeId, p.defaultPaletteId] = migrate(p.defaultThemeId, p.defaultPaletteId);
  p.defaultPaletteId ??= THEME_PALETTE_ID;
  for (const [themes, palettes] of [
    [p.botThemes, p.botPalettes!],
    [p.chatThemes, p.chatPalettes!],
  ]) {
    for (const [targetId, id] of Object.entries(themes)) {
      const [themeId, paletteId] = migrate(id, palettes[targetId]);
      themes[targetId] = themeId;
      if (paletteId !== undefined) palettes[targetId] = paletteId;
    }
  }
  return p;
}

export function resolvePaletteId(catalog: ThemeCatalog, scope: ThemeScope): string {
  const p = normalizeThemePreferences(catalog.preferences);
  for (const id of [
    scope.chatId && p.chatPalettes?.[scope.chatId],
    scope.botId && p.botPalettes?.[scope.botId],
    p.defaultPaletteId,
  ]) {
    if (isPaletteId(id)) return id;
  }
  return THEME_PALETTE_ID;
}

export function resolveTheme(catalog: ThemeCatalog, scope: ThemeScope): Theme {
  const p = normalizeThemePreferences(catalog.preferences);
  let selected = BUILTIN_THEMES[0];
  for (const id of [
    scope.chatId && p.chatThemes[scope.chatId],
    scope.botId && p.botThemes[scope.botId],
    p.defaultThemeId,
    DEFAULT_THEME_ID,
  ]) {
    const theme = id && (catalog.themes.find((item) => item.id === id) ?? getBuiltinTheme(id));
    if (theme) {
      selected = theme;
      break;
    }
  }
  const palette = BUILTIN_PALETTES.find((item) => item.id === resolvePaletteId(catalog, scope));
  return palette
    ? {
        ...selected,
        colors: { light: { ...palette.colors.light }, dark: { ...palette.colors.dark } },
      }
    : selected;
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
