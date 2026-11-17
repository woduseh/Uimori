export const storyUiStyles = ['default', 'east-asian', 'fantasy', 'modern', 'period'] as const;
export type StoryUiStyle = (typeof storyUiStyles)[number];
export function isStoryUiStyle(value: unknown): value is StoryUiStyle {
  return typeof value === 'string' && (storyUiStyles as readonly string[]).includes(value);
}
