import { IDENTITY_PATTERN } from './identity.js';
import type { Theme, ThemeCatalog } from './themes.js';

export const storyUiStyles = [
  'default',
  'east-asian',
  'fantasy',
  'modern',
  'period',
  'blue-archive',
  'idol',
  'neon',
  'horror',
  'tactical',
  'romance',
  'pop',
] as const;
export type StoryUiStyle = (typeof storyUiStyles)[number];
type StoryUiThemeSetting = `theme:${string}`;
export type StoryUiStyleSetting = StoryUiStyle | 'auto' | StoryUiThemeSetting;
export type StoryUiPresentation = { style: StoryUiStyle; theme?: Theme };

export function isStoryUiStyle(value: unknown): value is StoryUiStyle {
  return typeof value === 'string' && (storyUiStyles as readonly string[]).includes(value);
}
export function isStoryUiThemeSetting(value: unknown): value is StoryUiThemeSetting {
  if (typeof value !== 'string' || !value.startsWith('theme:')) return false;
  const id = value.slice('theme:'.length);
  return id.length <= 100 && IDENTITY_PATTERN.test(id);
}
export function isStoryUiStyleSetting(value: unknown): value is StoryUiStyleSetting {
  return value === 'auto' || isStoryUiStyle(value) || isStoryUiThemeSetting(value);
}

function blockMetadata(messages: unknown, key: 'style' | 'css'): unknown {
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  const message = Array.isArray(messages) ? messages[0] : undefined;
  const surface = record(message) ? message.createSurface : undefined;
  const dataModel = record(surface) ? surface.dataModel : undefined;
  const metadata = record(dataModel) ? dataModel._uimori : undefined;
  return record(metadata) ? metadata[key] : undefined;
}
const modelStoryUiStyle = (messages: unknown) => blockMetadata(messages, 'style');

export function storyUiBlockCss(
  setting: StoryUiStyleSetting | undefined,
  messages: unknown,
  presentation: StoryUiPresentation
): string {
  const css = blockMetadata(messages, 'css');
  return typeof css === 'string' &&
    (setting === undefined || setting === 'auto') &&
    !presentation.theme
    ? css
    : '';
}

export function resolveStoryUiPresentation(
  setting: StoryUiStyleSetting | undefined,
  messages: unknown,
  catalog?: ThemeCatalog,
  botId?: string
): StoryUiPresentation {
  const custom = (id: string | undefined): StoryUiPresentation | undefined => {
    const theme = id && catalog?.themes.find((item) => item.id === id);
    if (theme && theme.storyUi) return { style: theme.storyUi.baseStyle, theme };
  };
  if (isStoryUiStyle(setting)) return { style: setting };
  const selected = isStoryUiThemeSetting(setting)
    ? custom(setting.slice('theme:'.length))
    : custom(botId ? catalog?.preferences.botStoryUiThemes?.[botId] : undefined);
  if (selected) return selected;
  const model = modelStoryUiStyle(messages);
  if (isStoryUiStyle(model)) return { style: model };
  if (isStoryUiThemeSetting(model)) {
    const modelTheme = custom(model.slice('theme:'.length));
    if (modelTheme) return modelTheme;
  }
  return { style: 'default' };
}

export function resolveStoryUiStyle(
  setting: StoryUiStyleSetting | undefined,
  messages: unknown
): StoryUiStyle {
  return resolveStoryUiPresentation(setting, messages).style;
}
