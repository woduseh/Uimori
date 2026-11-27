import { z } from 'zod';
import { defineOperation } from '../../endpoint.js';
import { revision } from '../revision.js';
import { WRITTEN_LANGUAGES } from './written-language.js';

const translationLanguage = z.enum(WRITTEN_LANGUAGES).nullable();

export const autoTranslationDefaults = z.object({
  revision,
  autoTranslate: z.boolean(),
  translationLanguage,
});
export type AutoTranslationDefaults = z.infer<typeof autoTranslationDefaults>;

export const saveAutoTranslationDefaultsInput = z.object({
  expectedRevision: revision,
  autoTranslate: z.boolean(),
  translationLanguage: translationLanguage.optional(),
});
export type SaveAutoTranslationDefaults = z.infer<typeof saveAutoTranslationDefaultsInput>;

export const translationOperations = {
  readAutoTranslationDefaults: defineOperation(
    'translation.readAutoTranslationDefaults',
    z.object({}),
    autoTranslationDefaults
  ),
  saveAutoTranslationDefaults: defineOperation(
    'translation.saveAutoTranslationDefaults',
    saveAutoTranslationDefaultsInput,
    autoTranslationDefaults
  ),
};
