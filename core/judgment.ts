/** Typed judgment policy. It never selects a writing model or receives card credentials. */
export type JevJudgmentPolicy = {
  threshold: number;
  maxSelectedTokens: number;
  maxInputTokens: number;
};
export const DEFAULT_JEV_JUDGMENT: JevJudgmentPolicy = Object.freeze({
  threshold: 0.65,
  maxSelectedTokens: 8_000,
  maxInputTokens: 28_000,
});
export function validateJevJudgmentPolicy(value: unknown): JevJudgmentPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('JEV_POLICY_INVALID');
  const policy = value as JevJudgmentPolicy;
  if (
    Object.keys(policy).some((key) => !Object.hasOwn(DEFAULT_JEV_JUDGMENT, key)) ||
    !Number.isFinite(policy.threshold) ||
    policy.threshold < 0 ||
    policy.threshold > 1 ||
    !Number.isSafeInteger(policy.maxSelectedTokens) ||
    policy.maxSelectedTokens < 0 ||
    policy.maxSelectedTokens > 100_000 ||
    !Number.isSafeInteger(policy.maxInputTokens) ||
    policy.maxInputTokens < 1000 ||
    policy.maxInputTokens > 30_000
  )
    throw new Error('JEV_POLICY_INVALID');
  return { ...policy };
}

export type JevJudgmentReceipt = {
  threshold: number;
  maxSelectedTokens: number;
  selectedTokens: number;
  scores: { id: string; probability: number }[];
  attemptId?: string;
};
