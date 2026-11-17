export const storyUiStyles = [
  'default',
  'east-asian',
  'fantasy',
  'modern',
  'period',
  'blue-archive',
] as const;
export type StoryUiStyle = (typeof storyUiStyles)[number];
export type StoryUiStyleSetting = StoryUiStyle | 'auto';
export function isStoryUiStyle(value: unknown): value is StoryUiStyle {
  return typeof value === 'string' && (storyUiStyles as readonly string[]).includes(value);
}
export function isStoryUiStyleSetting(value: unknown): value is StoryUiStyleSetting {
  return value === 'auto' || isStoryUiStyle(value);
}

export function resolveStoryUiStyle(
  setting: StoryUiStyleSetting | undefined,
  messages: unknown
): StoryUiStyle {
  if (setting && setting !== 'auto') return setting;
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  const message = Array.isArray(messages) ? messages[0] : undefined;
  const surface = record(message) ? message.createSurface : undefined;
  const dataModel = record(surface) ? surface.dataModel : undefined;
  const metadata = record(dataModel) ? dataModel._uimori : undefined;
  const style = record(metadata) ? metadata.style : undefined;
  return isStoryUiStyle(style) ? style : 'default';
}
