import { domainCases, singletonExemption } from './harness.js';

export const translationCases = domainCases('translation', {
  saveAutoTranslationDefaults: { exempt: singletonExemption },
});
