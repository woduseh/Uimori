export const UI_LOCALES = ['ko', 'en', 'ja', 'zh'] as const;
export type UiLocale = (typeof UI_LOCALES)[number];

export function supportedLocale(value: unknown): UiLocale {
  return UI_LOCALES.includes(value as UiLocale) ? (value as UiLocale) : 'ko';
}
