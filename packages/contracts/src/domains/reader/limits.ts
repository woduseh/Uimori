export const REQUEST_IMAGE_MAX_COUNT = 8;
export const REQUEST_IMAGE_DIMENSION_MAX = 16383;
export const REQUEST_IMAGE_NAME_MAX_CHARS = 300;

export const INPUT_TRANSLATION_LANGUAGE_CODES = ['en', 'ja', 'ko', 'zh', 'fr', 'de', 'es'] as const;
export type InputTranslationLanguage = (typeof INPUT_TRANSLATION_LANGUAGE_CODES)[number];

export const REVISION_CONTEXTS = ['scene', 'nearby'] as const;
export type RevisionContext = (typeof REVISION_CONTEXTS)[number];

export const RESPONSE_TASK_KINDS = ['main', 'helper', 'translation'] as const;
export type ResponseTaskKind = (typeof RESPONSE_TASK_KINDS)[number];
