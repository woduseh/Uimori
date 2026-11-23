import type { ThemeBackground } from './theme-background.js';
import { isStoryUiStyle, type StoryUiStyle } from './story-ui-style.js';
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
  type Palette,
  type ThemePalette,
} from './theme-palettes.js';

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
  storyUi?: { baseStyle: StoryUiStyle; css: string; boardCss?: string };
  assets?: ThemeAsset[];
};
export type ThemeAssetKind = 'font' | 'image';
export type ThemeAsset = { name: string; kind: ThemeAssetKind; hash: string };
export type ThemeAssetFile = { hash: string; kind: ThemeAssetKind; mime: string; data: string };
export const MAX_THEME_ASSETS = 24;
export function themeAssetVariable(asset: Pick<ThemeAsset, 'name' | 'kind'>): string {
  return `--theme-${asset.kind}-${asset.name}`;
}
export type Theme = ThemeDefinition & { id: string; revision: number };
export type ThemePreferences = {
  revision: number;
  defaultThemeId: string;
  botThemes: Record<string, string>;
  chatThemes: Record<string, string>;
  botStoryUiThemes?: Record<string, string>;
  defaultPaletteId?: string;
  botPalettes?: Record<string, string>;
  chatPalettes?: Record<string, string>;
  defaultBackground?: ThemeBackground;
  botBackgrounds?: Record<string, ThemeBackground>;
  chatBackgrounds?: Record<string, ThemeBackground>;
};
export type ThemeCatalog = {
  themes: Theme[];
  palettes?: (Palette | ThemePalette)[];
  preferences: ThemePreferences;
};
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
export const BUILTIN_THEMES: Theme[] = [
  {
    ...emptyTheme('기본'),
    id: DEFAULT_THEME_ID,
    revision: 7,
    description: '군더더기 없는 기본 읽기 레이아웃',
    colors: DEFAULT_PALETTE_COLORS,
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
  { ...cinematicTheme, id: 'builtin:cinematic', revision: 6 },
  { ...letterTheme, id: 'builtin:letter', revision: 5 },
  { ...scrapbookTheme, id: 'builtin:scrapbook', revision: 6 },
  { ...classicFrameTheme, id: 'builtin:classic-frame', revision: 4 },
];
export function getBuiltinTheme(id: string): Theme | undefined {
  return BUILTIN_THEMES.find((theme) => theme.id === id);
}
export function themeDefinition(theme: Theme): ThemeDefinition {
  const { id: _id, revision: _revision, ...definition } = theme;
  return definition;
}

export function normalizeThemePreferences(value: ThemePreferences): ThemePreferences {
  return {
    ...value,
    defaultPaletteId: value.defaultPaletteId ?? THEME_PALETTE_ID,
    botThemes: { ...value.botThemes },
    chatThemes: { ...value.chatThemes },
    botPalettes: { ...value.botPalettes },
    chatPalettes: { ...value.chatPalettes },
    ...(value.botStoryUiThemes && { botStoryUiThemes: { ...value.botStoryUiThemes } }),
  };
}

export function resolvePaletteId(catalog: ThemeCatalog, scope: ThemeScope): string {
  const p = normalizeThemePreferences(catalog.preferences);
  for (const id of [
    scope.chatId && p.chatPalettes?.[scope.chatId],
    scope.botId && p.botPalettes?.[scope.botId],
    p.defaultPaletteId,
  ]) {
    if (
      isPaletteId(id) ||
      (typeof id === 'string' && catalog.palettes?.some((palette) => palette.id === id))
    )
      return id;
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
  const palette = (catalog.palettes ?? BUILTIN_PALETTES).find(
    (item) => item.id === resolvePaletteId(catalog, scope)
  );
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
  let storyUi: ThemeDefinition['storyUi'];
  if (v.storyUi !== undefined) {
    const definition = object(v.storyUi, '이야기 UI 테마');
    if (!isStoryUiStyle(definition.baseStyle))
      throw new Error('이야기 UI 테마의 기본 스타일을 선택해 주세요.');
    const boardCss =
      definition.boardCss === undefined
        ? ''
        : string(definition.boardCss, '현황 패널 CSS', 1_000_000);
    storyUi = {
      baseStyle: definition.baseStyle,
      css: string(definition.css, '이야기 UI CSS', 1_000_000),
      ...(boardCss && { boardCss }),
    };
  }
  const assets = validateThemeAssets(v.assets);
  return {
    title,
    description: string(v.description, '설명', 2000),
    colors,
    appCss: string(v.appCss, '앱 CSS', 1_000_000),
    messageCss: string(v.messageCss, '본문 CSS', 1_000_000),
    templateHtml: string(v.templateHtml, '레이아웃 HTML', 100_000),
    templateCss: string(v.templateCss, '레이아웃 CSS', 1_000_000),
    ...(storyUi && { storyUi }),
    ...(assets.length && { assets }),
  };
}
function validateThemeAssets(value: unknown): ThemeAsset[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_THEME_ASSETS)
    throw new Error(`자료 파일은 최대 ${MAX_THEME_ASSETS}개까지 넣을 수 있어요.`);
  const names = new Set<string>();
  return value.map((item) => {
    const asset = object(item, '자료 파일');
    const name = asset.name;
    if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/u.test(name))
      throw new Error(
        '자료 파일 이름은 영문 소문자로 시작하는 32자 이하 영문·숫자·하이픈이어야 해요.'
      );
    if (asset.kind !== 'font' && asset.kind !== 'image')
      throw new Error(`${name}: 글꼴 또는 이미지 자료만 넣을 수 있어요.`);
    if (typeof asset.hash !== 'string' || !/^[a-f0-9]{64}$/u.test(asset.hash))
      throw new Error(`${name}: 자료 파일 해시를 확인해 주세요.`);
    const key = `${asset.kind}:${name}`;
    if (names.has(key)) throw new Error(`${name}: 같은 이름의 자료 파일이 이미 있어요.`);
    names.add(key);
    return { name, kind: asset.kind, hash: asset.hash };
  });
}
export function parseThemeFile(value: unknown): {
  theme: ThemeDefinition;
  files: ThemeAssetFile[];
} {
  const file = object(value, '테마 파일');
  if (file.format !== THEME_FILE_FORMAT || (file.version !== 1 && file.version !== 2))
    throw new Error('Uimori 테마 파일이 아니에요. Risu 테마의 자동 변환은 지원하지 않아요.');
  const theme = validateTheme(file.theme);
  const files = file.version === 2 && Array.isArray(file.files) ? file.files : [];
  const parsed = files.map((item): ThemeAssetFile => {
    const entry = object(item, '자료 파일');
    if (
      typeof entry.hash !== 'string' ||
      (entry.kind !== 'font' && entry.kind !== 'image') ||
      typeof entry.mime !== 'string' ||
      typeof entry.data !== 'string'
    )
      throw new Error('테마 파일의 자료 파일 형식을 확인해 주세요.');
    return { hash: entry.hash, kind: entry.kind, mime: entry.mime, data: entry.data };
  });
  for (const asset of theme.assets ?? [])
    if (!parsed.some((entry) => entry.hash === asset.hash && entry.kind === asset.kind))
      throw new Error(`${asset.name}: 테마 파일에 이 자료 파일이 들어 있지 않아요.`);
  return { theme, files: parsed };
}
export function themeFile(theme: ThemeDefinition, files: ThemeAssetFile[] = []) {
  const definition = validateTheme(theme);
  const assets = definition.assets ?? [];
  if (!assets.length) return { format: THEME_FILE_FORMAT, version: 1, theme: definition };
  return {
    format: THEME_FILE_FORMAT,
    version: 2,
    theme: definition,
    files: files.filter((file) => assets.some((asset) => asset.hash === file.hash)),
  };
}
