import { t, formatDate, formatNumber, getLocale } from './i18n.js';
import type { UsageReport, UsageTotals } from '../core/usage-report.js';

export const usageNumber = (value: number) => formatNumber(value);
// Korean keeps the established K/M token notation; other locales use their own compact units.
export const usageCompact = (value: number) =>
  value < 10_000
    ? usageNumber(value)
    : getLocale() === 'ko'
      ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(value)
      : formatNumber(value, { notation: 'compact', maximumFractionDigits: 2 });
export const knownCost = (item: UsageTotals) =>
  item.reportedUsd + item.estimatedUsd + item.partialUsd;
export const usageUsd = (value: number) =>
  value > 0 && value < 0.01
    ? '<US$0.01'
    : formatNumber(value, {
        style: 'currency',
        currency: 'USD',
        currencyDisplay: 'code',
        maximumFractionDigits: 2,
      })
        .replace('USD', 'US$')
        .replace(/\s/u, '');
export const usageCost = (item: UsageTotals) =>
  item.calls > 0 && item.calls === item.unknownCostCalls
    ? t('visuals.m165')
    : usageUsd(knownCost(item));
export const exactCost = (item: UsageTotals) =>
  t('visuals.m267', {
    v0: `US$${formatNumber(item.reportedUsd, { maximumFractionDigits: 20 })}`,
    v1: `US$${formatNumber(item.estimatedUsd, { maximumFractionDigits: 20 })}`,
    v2: `US$${formatNumber(item.partialUsd, { maximumFractionDigits: 20 })}`,
  });
export const shortDay = (day: string) =>
  formatDate(new Date(`${day}T00:00:00Z`), { timeZone: 'UTC', month: 'numeric', day: 'numeric' });
const DAY = 86_400_000;
export const kstToday = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
export function usagePeriod(kind: 'today' | 'week' | 'month' | 'calendar') {
  const to = kstToday();
  const from =
    kind === 'calendar'
      ? `${to.slice(0, 7)}-01`
      : new Date(
          Date.parse(`${to}T00:00:00Z`) - (kind === 'today' ? 0 : kind === 'week' ? 6 : 29) * DAY
        )
          .toISOString()
          .slice(0, 10);
  return { from, to };
}
export function validUsageRange({ from, to }: { from: string; to: string }) {
  const valid = (day: string) =>
    /^\d{4}-\d{2}-\d{2}$/u.test(day) &&
    Number.isFinite(Date.parse(`${day}T00:00:00Z`)) &&
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
  return valid(from) && valid(to) && from <= to;
}
export type UsageBucket = {
  from: string;
  to: string;
  calls: number;
  amount: number;
  unknown: number;
  partial: number;
};
/** Bounded, equal calendar bins: gaps are missing records, never a claim of free usage. */
export function usageBuckets(report: Pick<UsageReport, 'from' | 'to' | 'days'>): {
  step: number;
  buckets: UsageBucket[];
} {
  if (!validUsageRange(report)) return { step: 1, buckets: [] };
  const start = Date.parse(`${report.from}T00:00:00Z`);
  const count = Math.round((Date.parse(`${report.to}T00:00:00Z`) - start) / DAY) + 1;
  const step = Math.max(1, Math.ceil(count / 60));
  const date = (offset: number) => new Date(start + offset * DAY).toISOString().slice(0, 10);
  const buckets = Array.from(
    { length: Math.ceil(count / step) },
    (_, index): UsageBucket => ({
      from: date(index * step),
      to: date(Math.min(count - 1, (index + 1) * step - 1)),
      calls: 0,
      amount: 0,
      unknown: 0,
      partial: 0,
    })
  );
  for (const day of report.days) {
    if (day.day < report.from || day.day > report.to) continue;
    const index = Math.floor((Date.parse(`${day.day}T00:00:00Z`) - start) / DAY / step);
    const bucket = buckets[index];
    if (!bucket) continue;
    bucket.calls += day.calls;
    bucket.amount += knownCost(day);
    bucket.unknown += day.unknownCostCalls;
    bucket.partial += day.partialCalls;
  }
  return { step, buckets };
}
export function bucketLabel(item: UsageBucket) {
  const date = item.from === item.to ? item.from : `${item.from} – ${item.to}`;
  return t('visuals.bucket', {
    date,
    cost: item.calls
      ? item.calls === item.unknown
        ? t('visuals.m268')
        : usageUsd(item.amount)
      : t('visuals.m269'),
    calls: item.calls,
    unknown: item.unknown,
    partial: item.partial,
  });
}
