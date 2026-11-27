import { z } from 'zod/v4';
import { defineOperation } from '../../endpoint.js';
import { revision } from '../revision.js';
import { WRITTEN_LANGUAGES } from './written-language.js';

const translationLanguage = z.enum(WRITTEN_LANGUAGES).nullable();

export const autoTranslationDefaults = z.strictObject({
  revision,
  autoTranslate: z.boolean(),
  translationLanguage,
});
export type AutoTranslationDefaults = z.infer<typeof autoTranslationDefaults>;

export const saveAutoTranslationDefaultsInput = z.strictObject({
  expectedRevision: revision,
  autoTranslate: z.boolean(),
  translationLanguage: translationLanguage.optional(),
});
export type SaveAutoTranslationDefaults = z.infer<typeof saveAutoTranslationDefaultsInput>;

export const translationOperations = {
  readAutoTranslationDefaults: defineOperation(
    'translation.readAutoTranslationDefaults',
    z.strictObject({}),
    autoTranslationDefaults
  ),
  saveAutoTranslationDefaults: defineOperation(
    'translation.saveAutoTranslationDefaults',
    saveAutoTranslationDefaultsInput,
    autoTranslationDefaults
  ),
};
