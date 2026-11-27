import { defineEndpoint } from '../../endpoint.js';
import type { translationOperations as operations } from './operations.js';

export const translationEndpoints = {
  readAutoTranslationDefaults: defineEndpoint<typeof operations.readAutoTranslationDefaults>({
    operation: 'translation.readAutoTranslationDefaults',
    method: 'GET',
    path: '/auto-translation-defaults',
  }),
  saveAutoTranslationDefaults: defineEndpoint<typeof operations.saveAutoTranslationDefaults>({
    operation: 'translation.saveAutoTranslationDefaults',
    method: 'PUT',
    path: '/auto-translation-defaults',
  }),
};
