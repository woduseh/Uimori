import type { ThemePreferences, ThemeScope } from './themes.js';

/** Independent presentation preference; never part of story/model input or theme exports. */
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
export function validateThemeBackground(value: unknown): ThemeBackground {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('배경 설정을 확인해 주세요.');
  const b = value as Record<string, unknown>;
  if (
    Object.keys(b).some(
      (key) => !['imageHash', 'blur', 'lightOverlay', 'darkOverlay'].includes(key)
    ) ||
    (b.imageHash !== null &&
      (typeof b.imageHash !== 'string' || !/^[a-f0-9]{64}$/u.test(b.imageHash))) ||
    !Number.isInteger(b.blur) ||
    Number(b.blur) < 0 ||
    Number(b.blur) > 30 ||
    !Number.isInteger(b.lightOverlay) ||
    Number(b.lightOverlay) < 0 ||
    Number(b.lightOverlay) > 100 ||
    !Number.isInteger(b.darkOverlay) ||
    Number(b.darkOverlay) < 0 ||
    Number(b.darkOverlay) > 100
  )
    throw new Error('배경 이미지와 흐림·덮개 범위를 확인해 주세요.');
  return {
    imageHash: b.imageHash as string | null,
    blur: Number(b.blur),
    lightOverlay: Number(b.lightOverlay),
    darkOverlay: Number(b.darkOverlay),
  };
}
export function resolveThemeBackground(p: ThemePreferences, scope: ThemeScope): ThemeBackground {
  return (
    (scope.chatId && p.chatBackgrounds?.[scope.chatId]) ||
    (scope.botId && p.botBackgrounds?.[scope.botId]) ||
    p.defaultBackground ||
    defaultThemeBackground
  );
}
