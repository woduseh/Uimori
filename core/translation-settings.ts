/** null removes app chunking only; provider budgets still apply. */
export function translationChunkChars(value: unknown): number | null {
  if (value === undefined) return 3000;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 100 || value > 24000)
    throw new Error('번역 구간 기준은 100~24,000 사이의 정수 또는 무제한이어야 해요.');
  return value;
}
