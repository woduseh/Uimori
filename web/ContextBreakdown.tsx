import type { CSSProperties } from 'react';
import { formatNumber, t, useI18n } from './i18n.js';
import { usageCompact } from './usage-display.js';
import './context-breakdown.css';

export type ContextTone =
  | 'instructions'
  | 'tools'
  | 'history'
  | 'summary'
  | 'reference'
  | 'description'
  | 'persona'
  | 'note'
  | 'guide'
  | 'request'
  | 'results'
  | 'other';

export type ContextSegment = { key: string; label: string; tokens: number; tone: ContextTone };
export type ContextRow = { key: string; label: string; tokens: number | null; tone?: ContextTone };
export type ContextNote = { key: string; label: string; value: string };

export function ContextBar({
  segments,
  total,
  limit,
  threshold,
}: {
  segments: readonly ContextSegment[];
  total: number;
  limit: number;
  threshold?: number | null;
}) {
  const scale = Math.max(limit, total);
  const measured = segments.reduce((sum, segment) => sum + segment.tokens, 0);
  const ratio = measured > 0 ? total / measured : 0;
  return (
    <span
      className="context-breakdown-bar"
      aria-hidden="true"
      data-threshold={threshold == null ? undefined : ''}
      style={(threshold == null ? {} : { '--usage-threshold': threshold / scale }) as CSSProperties}
    >
      {segments.map(({ key, tokens, tone }) => (
        <span
          key={key}
          className="context-breakdown-segment"
          data-part={key}
          data-tone={tone}
          style={{ '--part-share': (tokens * ratio) / scale } as CSSProperties}
        />
      ))}
    </span>
  );
}

export function ContextLegend({ segments }: { segments: readonly ContextSegment[] }) {
  useI18n();
  return (
    <ul className="context-breakdown-legend">
      {segments.map(({ key, label, tokens, tone }) => (
        <li key={key}>
          <span className="context-breakdown-key" data-tone={tone} aria-hidden="true" />
          <span>{label}</span>
          <span className="context-breakdown-legend-value">{usageCompact(tokens)}</span>
        </li>
      ))}
    </ul>
  );
}

export function ContextTable({
  label,
  rows,
  total,
  limit,
  threshold = null,
  notes = [],
}: {
  label: string;
  rows: readonly ContextRow[];
  total?: number | null;
  limit: number | null;
  threshold?: number | null;
  notes?: readonly ContextNote[];
}) {
  useI18n();
  const value = (amount: number | null) =>
    amount === null ? t('contextBreakdown.unknown') : formatNumber(amount);
  const percent = (amount: number | null) =>
    amount === null || !limit
      ? ''
      : formatNumber(amount / limit, { style: 'percent', maximumFractionDigits: 1 });
  const row = (
    key: string,
    name: string,
    amount: string,
    marker?: string,
    shareText = '',
    className?: string
  ) => (
    <tr key={key} className={className}>
      <th scope="row">
        <span className="context-breakdown-name">
          <span className="context-breakdown-key" data-tone={marker} aria-hidden="true" />
          {name}
        </span>
      </th>
      <td>{amount}</td>
      {limit !== null && <td>{shareText}</td>}
    </tr>
  );
  return (
    <table className="context-breakdown-table" aria-label={label}>
      <thead className="sr-only">
        <tr>
          <th scope="col">{t('contextBreakdown.columnPart')}</th>
          <th scope="col">{t('contextBreakdown.columnTokens')}</th>
          {limit !== null && <th scope="col">{t('contextBreakdown.columnShare')}</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((item) =>
          row(item.key, item.label, value(item.tokens), item.tone, percent(item.tokens))
        )}
      </tbody>
      {total !== undefined && (
        <tbody>
          {row(
            'total',
            t('contextBreakdown.total'),
            value(total),
            undefined,
            percent(total),
            'context-breakdown-total'
          )}
          {limit !== null &&
            total !== null &&
            row(
              'free',
              t('contextBreakdown.free'),
              formatNumber(Math.max(0, limit - total)),
              'free',
              percent(Math.max(0, limit - total))
            )}
          {(limit === null || total === null) &&
            row('limit', t('contextBreakdown.limit'), value(limit))}
          {threshold !== null &&
            row(
              'threshold',
              t('contextBreakdown.threshold'),
              formatNumber(threshold),
              'threshold',
              percent(threshold)
            )}
          {notes.map((note) => row(note.key, note.label, note.value))}
        </tbody>
      )}
    </table>
  );
}
