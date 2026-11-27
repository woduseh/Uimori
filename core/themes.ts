import type { ThemeBackground } from './theme-background.js';
import { isStoryUiStyle, storyUiStyles, type StoryUiStyle } from './story-ui-style.js';
import { ValidationError } from './validation-error.js';
import { THEME_COLOR_KEYS } from '#contracts';
import {
  cinematicTheme,
  letterTheme,
  scrapbookTheme,
  classicFrameTheme,
} from './narrative-themes.js';
import {
  DEFAULT_PALETTE_COLORS,
  THEME_PALETTE_ID,
  isPaletteId,
  type Palette,
  type ThemePalette,
} from './theme-palettes.js';

export { THEME_COLOR_KEYS };
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
  palettes: (Palette | ThemePalette)[];
  preferences: ThemePreferences;
};
export type ThemeScope = { botId?: string; chatId?: string };
export const DEFAULT_THEME_ID = 'builtin:forest';
export type BuiltinThemeId =
  | typeof DEFAULT_THEME_ID
  | 'builtin:cinematic'
  | 'builtin:letter'
  | 'builtin:scrapbook'
  | 'builtin:classic-frame';
export const THEME_FILE_FORMAT = 'uimori-theme';
export const DEFAULT_THEME_TEMPLATE =
  '<slot name="request"></slot><slot name="heading"></slot><slot name="body"></slot><slot name="actions"></slot><slot></slot>';
export const THEME_SLOTS = ['request', 'heading', 'body', 'actions'] as const;
export const THEME_TITLE_MAX_CHARS = 100;
export function copyTitle(title: string, suffix: string): string {
  const characters = Array.from(title);
  while (
    characters.length &&
    characters.join('').trimEnd().length + suffix.length > THEME_TITLE_MAX_CHARS
  )
    characters.pop();
  return characters.join('').trimEnd() + suffix;
}
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
export const BUILTIN_THEMES: (Theme & { id: BuiltinThemeId })[] = [
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
      (typeof id === 'string' && catalog.palettes.some((palette) => palette.id === id))
    )
      return id;
  }
  return THEME_PALETTE_ID;
}

export function resolveTheme(catalog: ThemeCatalog, scope: ThemeScope): Theme {
  const p = normalizeThemePreferences(catalog.preferences);
  let selected: Theme = BUILTIN_THEMES[0];
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
  const palette = catalog.palettes.find((item) => item.id === resolvePaletteId(catalog, scope));
  return palette
    ? {
        ...selected,
        colors: { light: { ...palette.colors.light }, dark: { ...palette.colors.dark } },
      }
    : selected;
}
function object(value: unknown, field: string, path = field): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ValidationError(400, 'THEME_OBJECT_REQUIRED', `${path}: expected an object.`, {
      field,
    });
  return value as Record<string, unknown>;
}
function string(value: unknown, field: string, limit: number, fallback = ''): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > limit)
    throw new ValidationError(
      400,
      'THEME_FIELD_TOO_LONG',
      `${field}: expected a string of at most ${limit} characters.`,
      { field, limit }
    );
  return value;
}
export function validateTheme(value: unknown): ThemeDefinition {
  const v = object(value, 'theme');
  const title = string(v.title, 'title', THEME_TITLE_MAX_CHARS).trim();
  if (!title) throw new ValidationError(400, 'THEME_TITLE_REQUIRED', 'title: enter a name.');
  const colorInput = v.colors === undefined ? {} : object(v.colors, 'colors');
  const colors: ThemeDefinition['colors'] = { light: {}, dark: {} };
  for (const mode of ['light', 'dark'] as const) {
    const entries =
      colorInput[mode] === undefined ? {} : object(colorInput[mode], 'colors', `colors.${mode}`);
    for (const [key, color] of Object.entries(entries)) {
      if (!THEME_COLOR_KEYS.includes(key as ThemeColorKey))
        throw new ValidationError(
          400,
          'THEME_COLOR_UNSUPPORTED',
          `colors.${mode}.${key}: unsupported color variable; use one of ${THEME_COLOR_KEYS.join(', ')}.`,
          { key }
        );
      if (typeof color !== 'string' || !/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(color))
        throw new ValidationError(
          400,
          'THEME_COLOR_INVALID',
          `colors.${mode}.${key}: expected a hex color such as #RRGGBB.`,
          { key }
        );
      colors[mode][key as ThemeColorKey] = color;
    }
  }
  let storyUi: ThemeDefinition['storyUi'];
  if (v.storyUi !== undefined) {
    const definition = object(v.storyUi, 'storyUi');
    if (!isStoryUiStyle(definition.baseStyle))
      throw new ValidationError(
        400,
        'THEME_STORY_UI_STYLE_REQUIRED',
        `storyUi.baseStyle: choose a supported story UI style: ${storyUiStyles.join(', ')}.`
      );
    const boardCss =
      definition.boardCss === undefined
        ? ''
        : string(definition.boardCss, 'storyUi.boardCss', 1_000_000);
    storyUi = {
      baseStyle: definition.baseStyle,
      css: string(definition.css, 'storyUi.css', 1_000_000),
      ...(boardCss && { boardCss }),
    };
  }
  const assets = validateThemeAssets(v.assets);
  return {
    title,
    description: string(v.description, 'description', 2000),
    colors,
    appCss: string(v.appCss, 'appCss', 1_000_000),
    messageCss: string(v.messageCss, 'messageCss', 1_000_000),
    templateHtml: string(v.templateHtml, 'templateHtml', 100_000),
    templateCss: string(v.templateCss, 'templateCss', 1_000_000),
    ...(storyUi && { storyUi }),
    ...(assets.length && { assets }),
  };
}
function validateThemeAssets(value: unknown): ThemeAsset[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_THEME_ASSETS)
    throw new ValidationError(
      400,
      'THEME_ASSETS_TOO_MANY',
      `assets: expected an array of at most ${MAX_THEME_ASSETS} items.`,
      { limit: MAX_THEME_ASSETS }
    );
  const names = new Set<string>();
  return value.map((item, index) => {
    const asset = object(item, 'assets', `assets[${index}]`);
    const name = asset.name;
    if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/u.test(name))
      throw new ValidationError(
        400,
        'THEME_ASSET_NAME_INVALID',
        `assets[${index}].name: expected 1-32 lowercase letters, digits or hyphens, starting with a letter.`
      );
    if (asset.kind !== 'font' && asset.kind !== 'image')
      throw new ValidationError(
        400,
        'THEME_ASSET_KIND_INVALID',
        `assets[${index}].kind: expected font or image.`,
        { name }
      );
    if (typeof asset.hash !== 'string' || !/^[a-f0-9]{64}$/u.test(asset.hash))
      throw new ValidationError(
        400,
        'THEME_ASSET_HASH_INVALID',
        `assets[${index}].hash: expected a lowercase SHA-256 hex digest.`,
        { name }
      );
    const key = `${asset.kind}:${name}`;
    if (names.has(key))
      throw new ValidationError(
        400,
        'THEME_ASSET_DUPLICATE',
        `assets[${index}].name: another ${asset.kind} asset is already named ${name}.`,
        { name }
      );
    names.add(key);
    return { name, kind: asset.kind, hash: asset.hash };
  });
}
export function parseThemeFile(value: unknown): {
  theme: ThemeDefinition;
  files: ThemeAssetFile[];
} {
  const file = object(value, 'file');
  if (file.format !== THEME_FILE_FORMAT || (file.version !== 1 && file.version !== 2))
    throw new ValidationError(
      400,
      'THEME_FILE_UNSUPPORTED',
      `Expected format "${THEME_FILE_FORMAT}" with version 1 or 2; Risu themes are not converted.`
    );
  const theme = validateTheme(file.theme);
  const files = file.version === 2 && Array.isArray(file.files) ? file.files : [];
  const parsed = files.map((item, index): ThemeAssetFile => {
    const entry = object(item, 'files', `files[${index}]`);
    if (
      typeof entry.hash !== 'string' ||
      (entry.kind !== 'font' && entry.kind !== 'image') ||
      typeof entry.mime !== 'string' ||
      typeof entry.data !== 'string'
    )
      throw new ValidationError(
        400,
        'THEME_FILE_ASSET_INVALID',
        `files[${index}]: expected hash, kind (font or image), mime and data strings.`
      );
    return { hash: entry.hash, kind: entry.kind, mime: entry.mime, data: entry.data };
  });
  for (const asset of theme.assets ?? [])
    if (!parsed.some((entry) => entry.hash === asset.hash && entry.kind === asset.kind))
      throw new ValidationError(
        400,
        'THEME_FILE_ASSET_MISSING',
        `files: no ${asset.kind} file with the hash of asset ${asset.name}.`,
        { name: asset.name }
      );
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
