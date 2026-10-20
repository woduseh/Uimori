import { t, formatNumber } from './i18n.js';
import type { TokenRates } from '../core/pricing-types.js';

export const pricingRateLabels: Record<keyof Required<TokenRates>, string> = {
  get input() {
    return t('providers.m487');
  },
  get cacheRead() {
    return t('providers.m513');
  },
  get cacheWrite() {
    return t('providers.m514');
  },
  get output() {
    return t('providers.m515');
  },
  get cacheWrite1h() {
    return t('providers.m516');
  },
};
export const formatUsd = (value: number | null | undefined) =>
  value === null || value === undefined
    ? t('providers.m489')
    : value > 0 && value < 0.00000001
      ? '< $0.00000001'
      : `$${formatNumber(value, { maximumFractionDigits: 8 })}`;

const estimateNotes: Record<string, string> = {
  get PRICING_UNAVAILABLE() {
    return t('providers.m517');
  },
  get PRICING_VERSION_UNSUPPORTED() {
    return t('providers.m518');
  },
  get PRICING_PROTOCOL_UNSUPPORTED() {
    return t('providers.m519');
  },
  get SERVICE_TIER_MISMATCH() {
    return t('providers.m520');
  },
  get INCONSISTENT_INPUT_USAGE() {
    return t('providers.m521');
  },
  get PRICING_START_TIME_INVALID() {
    return t('providers.m522');
  },
  get PRICING_SCHEDULE_INVALID() {
    return t('providers.m523');
  },
  get PEAK_RATES_APPLIED() {
    return t('providers.m524');
  },
  get PRICING_THRESHOLD_INVALID() {
    return t('providers.m525');
  },
  get CONTEXT_PRICE_TIER_UNKNOWN() {
    return t('providers.m526');
  },
  get LONG_CONTEXT_RATES_APPLIED() {
    return t('providers.m527');
  },
  get CACHE_WRITE_SPLIT_UNKNOWN() {
    return t('providers.m528');
  },
  get ESTIMATE_OVERFLOW() {
    return t('providers.m529');
  },
  get USAGE_OR_RATE_UNKNOWN() {
    return t('providers.m530');
  },
};

export function pricingNote(note: string): string {
  return estimateNotes[note] ?? (/^[A-Z][A-Z0-9_]+$/.test(note) ? t('providers.m531') : note);
}
