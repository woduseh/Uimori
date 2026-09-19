import type { ModelSnapshot } from './product.js';

export type TranslationPolicy = {
  refusalModel: ModelSnapshot | null;
  judgment?: TranslationJudgmentPolicy;
  maxRetries: number;
  maxCalls: number;
};
export type TranslationJudgmentPolicy = { backend: 'jev'; threshold: number };
export const DEFAULT_TRANSLATION_JUDGMENT: TranslationJudgmentPolicy = Object.freeze({
  backend: 'jev',
  threshold: 0.9,
});
export function validateTranslationJudgmentPolicy(value: unknown): TranslationJudgmentPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('TRANSLATION_JUDGMENT_INVALID');
  const policy = value as TranslationJudgmentPolicy;
  if (
    Object.keys(policy).some((key) => !['backend', 'threshold'].includes(key)) ||
    policy.backend !== 'jev' ||
    typeof policy.threshold !== 'number' ||
    !Number.isFinite(policy.threshold) ||
    policy.threshold <= 0.5 ||
    policy.threshold > 1
  )
    throw new Error('TRANSLATION_JUDGMENT_INVALID');
  return { backend: 'jev', threshold: policy.threshold };
}
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
    ...(value?.judgment !== undefined
      ? { judgment: validateTranslationJudgmentPolicy(value.judgment) }
      : {}),
    maxRetries: translationMaxRetries(value?.maxRetries),
    maxCalls: translationMaxCalls(value?.maxCalls),
  };
}
export type TranslationRefusalVerdict = 'accepted' | 'refused' | 'uncertain';
export function parseTranslationRefusalVerdict(text: string): TranslationRefusalVerdict {
  try {
    // Accept only an outer wrapper, never extract JSON from explanatory prose.
    const trimmed = text.trim();
    const fence = /^```json[\t ]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
    const value: unknown = JSON.parse(fence ? fence[1].trim() : trimmed);
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
