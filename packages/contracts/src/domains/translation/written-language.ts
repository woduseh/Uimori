export const WRITTEN_LANGUAGES = ['ko', 'en', 'ja', 'zh'] as const;
export type WrittenLanguage = (typeof WRITTEN_LANGUAGES)[number];
