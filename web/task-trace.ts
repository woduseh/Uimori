import { formatNumber, t } from './i18n.js';
import { formatUsdSummary } from './pricing-display.js';
import type { TraceCallKind, TraceCostGroup, TraceCostTotal } from '../core/task-trace.js';

export const traceKindLabel = (kind: TraceCallKind) => t(`taskTrace.kind.${kind}`);
export const traceCostGroupLabel = (group: TraceCostGroup) => t(`taskTrace.costGroup.${group}`);
export const traceStatusLabel = (status: string) => t('taskTrace.status', { status });

export function formatDurationMs(value: number) {
  if (value < 1000) return t('taskTrace.durationMs', { value: Math.round(value) });
  const seconds = value / 1000;
  if (seconds < 60)
    return t('taskTrace.durationSeconds', {
      value: formatNumber(seconds, { maximumFractionDigits: seconds < 10 ? 1 : 0 }),
    });
  const whole = Math.round(seconds);
  return t('taskTrace.durationMinutes', { minutes: Math.floor(whole / 60), seconds: whole % 60 });
}

export function traceCostSummary(total: TraceCostTotal) {
  if (!total.attemptCount || (total.usd === null && total.subtotalUsd === 0)) return null;
  return total.usd !== null
    ? formatUsdSummary(total.usd)
    : t('reader.inspectorCostAtLeast', { value: formatUsdSummary(total.subtotalUsd) });
}

export const formatShare = (part: number, whole: number) =>
  formatNumber(whole > 0 ? part / whole : 0, { style: 'percent', maximumFractionDigits: 0 });
