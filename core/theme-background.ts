import type { ThemePreferences, ThemeScope } from './themes.js';

export type ThemeBackground = {
  imageHash: string | null;
  blur: number;
  lightOverlay: number;
  darkOverlay: number;
};
export const defaultThemeBackground: ThemeBackground = {
  imageHash: null,
  blur: 0,
  lightOverlay: 35,
  darkOverlay: 45,
};
export function resolveThemeBackground(p: ThemePreferences, scope: ThemeScope): ThemeBackground {
  return (
    (scope.chatId && p.chatBackgrounds?.[scope.chatId]) ||
    (scope.botId && p.botBackgrounds?.[scope.botId]) ||
    p.defaultBackground ||
    defaultThemeBackground
  );
}
