export type JevJudgmentPolicy = {
  threshold: number;
  maxSelectedTokens: number;
  maxInputTokens: number;
};
export const DEFAULT_JEV_JUDGMENT: JevJudgmentPolicy = Object.freeze({
  threshold: 0.65,
  maxSelectedTokens: 8_000,
  maxInputTokens: 262_000,
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
    policy.maxInputTokens > 262_000
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
import type { Json } from './transport.js';

export type JudgmentTarget = {
  provider: 'typesafe' | 'typesafe-compatible' | 'openai' | 'gemini' | 'openai-compatible';
  connectionId: string;
  modelId: string;
  endpoint: string;
};
export type JudgmentQuestion =
  | { type: 'noul'; instructions: Json }
  | { type: 'choice'; instructions: Json; criteria: Record<string, string | null> };
export type JudgmentRequest = {
  state: Json;
  questions: Record<string, JudgmentQuestion>;
  assets?: Record<string, { type: 'image'; format: 'jpeg' | 'png'; data_base64: string }>;
};

export function validJudgmentTarget(target: JudgmentTarget): boolean {
  if (!target.connectionId || !target.modelId || !target.endpoint) return false;
  if (target.provider === 'typesafe')
    return (
      target.connectionId === 'typesafe-judgment' &&
      target.modelId === 'jev-latest' &&
      target.endpoint === 'https://api.typesafe.ai/v1/systemone'
    );
  if (target.provider === 'openai')
    return (
      target.modelId === 'gpt-6-luna' && target.endpoint === 'https://api.openai.com/v1/decisions'
    );
  if (target.provider === 'gemini')
    return (
      target.modelId === 'gemini-decision-1' &&
      target.endpoint === 'https://generativelanguage.googleapis.com/v1beta/decisions'
    );
  if (target.provider !== 'openai-compatible' && target.provider !== 'typesafe-compatible')
    return false;
  try {
    const url = new URL(target.endpoint);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.href === target.endpoint
    );
  } catch {
    return false;
  }
}
