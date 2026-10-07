import type { UsageReport, UsageTotals } from '../core/usage-report.js';

export const usageNumber = (value: number) => value.toLocaleString('ko-KR');
export const usageCompact = (value: number) =>
  value < 10_000
    ? usageNumber(value)
    : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
export const knownCost = (item: UsageTotals) =>
  item.reportedUsd + item.estimatedUsd + item.partialUsd;
export const usageUsd = (value: number) =>
  value > 0 && value < 0.01
    ? '<US$0.01'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        currencyDisplay: 'code',
        maximumFractionDigits: 2,
      })
        .format(value)
        .replace('USD', 'US$')
        .replace(/\s/u, '');
export const usageCost = (item: UsageTotals) =>
  item.calls > 0 && item.calls === item.unknownCostCalls ? '미확인' : usageUsd(knownCost(item));
export const exactCost = (item: UsageTotals) =>
  `프로바이더 보고 US$${item.reportedUsd} · 추정 US$${item.estimatedUsd} · 부분 추정 US$${item.partialUsd}`;
export const shortDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
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
  return `${date} · ${item.calls ? (item.calls === item.unknown ? '비용 미확인' : usageUsd(item.amount)) : '기록 없음'}${item.calls ? ` · ${usageNumber(item.calls)}회` : ''}${item.unknown ? ` · 미확인 ${item.unknown}회` : ''}${item.partial ? ` · 부분 추정 ${item.partial}회` : ''}`;
}
