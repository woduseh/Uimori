import type { ModelSnapshot } from './product.js';

export type TranslationPolicy = {
  refusalModel: ModelSnapshot | null;
  maxRetries: number;
  maxCalls: number;
};
export const DEFAULT_TRANSLATION_MAX_RETRIES = 1;
export const DEFAULT_TRANSLATION_MAX_CALLS = 16;
export function translationMaxRetries(value: unknown = DEFAULT_TRANSLATION_MAX_RETRIES): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 5)
    throw new Error('TRANSLATION_RETRY_LIMIT_INVALID');
  return value as number;
}
export function translationMaxCalls(value: unknown = DEFAULT_TRANSLATION_MAX_CALLS): number {
  if (!Number.isSafeInteger(value) || (value as number) < 2 || (value as number) > 64)
    throw new Error('TRANSLATION_CALL_LIMIT_INVALID');
  return value as number;
}
export function translationPolicy(value?: TranslationPolicy): TranslationPolicy {
  return {
    refusalModel: value?.refusalModel ? structuredClone(value.refusalModel) : null,
    maxRetries: translationMaxRetries(value?.maxRetries),
    maxCalls: translationMaxCalls(value?.maxCalls),
  };
}
export type TranslationRefusalVerdict = 'accepted' | 'refused' | 'uncertain';
export function parseTranslationRefusalVerdict(text: string): TranslationRefusalVerdict {
  try {
    const value: unknown = JSON.parse(text);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !Object.hasOwn(value, 'verdict')
    )
      return 'uncertain';
    const verdict = (value as { verdict: unknown }).verdict;
    return verdict === 'accepted' || verdict === 'refused' ? verdict : 'uncertain';
  } catch {
    return 'uncertain';
  }
}
