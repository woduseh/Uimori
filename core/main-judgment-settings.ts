export const DEFAULT_MAIN_JUDGMENT_THRESHOLD = 0.9;

export function mainJudgmentThreshold(value: unknown = DEFAULT_MAIN_JUDGMENT_THRESHOLD): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0.5 || value > 1)
    throw new Error('MAIN_JUDGMENT_THRESHOLD_INVALID');
  return value;
}
