export type TranslationPolicy = {
  judgment: TranslationJudgmentPolicy;
  maxRetries: number;
  maxCalls: number;
};
export type TranslationJudgmentPolicy = { threshold: number; enabled?: boolean };
export const DEFAULT_TRANSLATION_JUDGMENT: TranslationJudgmentPolicy = Object.freeze({
  threshold: 0.9,
});
export function validateTranslationJudgmentPolicy(value: unknown): TranslationJudgmentPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('TRANSLATION_JUDGMENT_INVALID');
  const policy = value as TranslationJudgmentPolicy;
  if (
    Object.keys(policy).some((key) => !['threshold', 'enabled'].includes(key)) ||
    (policy.enabled !== undefined && typeof policy.enabled !== 'boolean') ||
    typeof policy.threshold !== 'number' ||
    !Number.isFinite(policy.threshold) ||
    policy.threshold <= 0.5 ||
    policy.threshold > 1
  )
    throw new Error('TRANSLATION_JUDGMENT_INVALID');
  return {
    threshold: policy.threshold,
    ...(policy.enabled !== undefined ? { enabled: policy.enabled } : {}),
  };
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
  if (
    value !== undefined &&
    (!value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !['judgment', 'maxRetries', 'maxCalls'].includes(key)))
  )
    throw new Error('TRANSLATION_POLICY_INVALID');
  return {
    judgment: validateTranslationJudgmentPolicy(
      value === undefined ? DEFAULT_TRANSLATION_JUDGMENT : value.judgment
    ),
    maxRetries: translationMaxRetries(value?.maxRetries),
    maxCalls: translationMaxCalls(value?.maxCalls),
  };
}
export type TranslationRefusalVerdict = 'accepted' | 'refused';
