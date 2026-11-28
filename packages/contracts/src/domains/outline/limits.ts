import { REQUEST_TEXT_MAX_CHARS } from '../limits.js';

export const OUTLINE_LEVELS = ['theme', 'mainStory', 'arc', 'episode', 'beat'] as const;
export type OutlineLevel = (typeof OUTLINE_LEVELS)[number];
export const OUTLINE_WRITING_ORIGINS = ['planned', 'focus'] as const;
export type OutlineWritingOrigin = (typeof OUTLINE_WRITING_ORIGINS)[number];

export const OUTLINE_TITLE_MAX = 200;
export const OUTLINE_INTENT_MAX = REQUEST_TEXT_MAX_CHARS;
export const OUTLINE_BATCH_LIMIT = 200;
export const OUTLINE_RELATED_LIMIT = 40;
export const OUTLINE_POSITION_MAX = 1_000_000;
