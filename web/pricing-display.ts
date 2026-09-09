import type { TokenRates } from '../core/pricing-types.js';

export const pricingRateLabels: Record<keyof Required<TokenRates>, string> = {
  input: '입력',
  cacheRead: '캐시 읽기',
  cacheWrite: '캐시 쓰기',
  output: '출력',
  cacheWrite1h: '1시간 캐시 쓰기',
};
export const formatUsd = (value: number | null | undefined) =>
  value === null || value === undefined
    ? '미확인'
    : value > 0 && value < 0.00000001
      ? '< $0.00000001'
      : `$${value.toLocaleString('en-US', { maximumFractionDigits: 8 })}`;

const estimateNotes: Record<string, string> = {
  PRICING_UNAVAILABLE: '이 호출에 사용할 요금을 확인하지 못했어요.',
  PRICING_VERSION_UNSUPPORTED: '저장된 요금 형식을 현재 추정 계산에서 지원하지 않아요.',
  PRICING_PROTOCOL_UNSUPPORTED: '이 프로바이더의 토큰 요금 계산은 아직 지원하지 않아요.',
  SERVICE_TIER_MISMATCH:
    '공급자가 보고한 요청 등급이 고정된 요금의 등급과 달라 금액을 추정하지 않았어요.',
  INCONSISTENT_INPUT_USAGE:
    '공급자가 보고한 입력·캐시 토큰 수가 서로 맞지 않아 해당 금액을 미확인으로 표시해요.',
  PRICING_START_TIME_INVALID: '호출 시작 시각을 확인하지 못해 시간대별 요금을 계산하지 못했어요.',
  PRICING_SCHEDULE_INVALID: '시간대별 요금 기준이 올바르지 않아 금액을 추정하지 않았어요.',
  PEAK_RATES_APPLIED: '호출 시작 시각에 해당하는 혼잡 시간대 요금을 적용했어요.',
  PRICING_THRESHOLD_INVALID: '장문 요금의 입력 토큰 기준이 올바르지 않아 금액을 추정하지 않았어요.',
  CONTEXT_PRICE_TIER_UNKNOWN:
    '전체 입력 토큰을 확인하지 못해 일반·장문 요금 중 적용할 요금을 정하지 못했어요.',
  LONG_CONTEXT_RATES_APPLIED: '입력 토큰이 기준을 초과해 장문 요금을 적용했어요.',
  CACHE_WRITE_SPLIT_UNKNOWN: '캐시 쓰기의 5분·1시간 토큰 구분을 확인하지 못했어요.',
  ESTIMATE_OVERFLOW: '계산 결과가 처리 가능한 금액 범위를 벗어나 추정 금액을 표시하지 않아요.',
  USAGE_OR_RATE_UNKNOWN:
    '일부 토큰 수나 요금이 미확인이에요. 표시된 부분합은 확인된 항목만 포함해요.',
};

export function pricingNote(note: string): string {
  return (
    estimateNotes[note] ??
    (/^[A-Z][A-Z0-9_]+$/.test(note)
      ? '추정 비용 계산에 필요한 일부 정보를 확인하지 못했어요.'
      : note)
  );
}
