import { t, useI18n, formatDate, formatNumber, getIntlLocale } from './i18n.js';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { statusGlyph, type StatusTone } from './TurnStatus.js';
import { elapsedLabel } from './ActivityStatus.js';
import { CopyIcon, DropdownIcon } from './ui-icons.js';
import './task-history.css';

export type TaskHistoryFilter = 'all' | 'running' | 'issue';

export function taskStatusTone(status: string): StatusTone {
  if (['sending', 'accepted', 'queued', 'running'].includes(status)) return 'running';
  if (status === 'completed') return 'done';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'uncertain') return 'uncertain';
  return 'issue';
}

export function matchesTaskHistoryFilter(tone: StatusTone, filter: TaskHistoryFilter) {
  if (filter === 'running') return tone === 'running';
  if (filter === 'issue') return tone === 'issue' || tone === 'uncertain';
  return true;
}

function useNow(intervalMs: number, ticking: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, ticking]);
  return now;
}

const relativeUnits: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
];

export function formatRelativeTime(at: string, now: number) {
  const timestamp = Date.parse(at);
  if (!Number.isFinite(timestamp)) return '';
  const format = new Intl.RelativeTimeFormat(getIntlLocale(), { numeric: 'auto' });
  let value = Math.round((timestamp - now) / 1000);
  for (const [unit, limit] of relativeUnits) {
    if (Math.abs(value) < limit) return format.format(value, unit);
    value = Math.round(value / limit);
  }
  return formatDate(timestamp, { dateStyle: 'medium' });
}

export function TaskHistoryTime({ at }: { at: string }) {
  useI18n();
  const now = useNow(30_000, true);
  return (
    <time dateTime={at} title={formatDate(at, { dateStyle: 'medium', timeStyle: 'medium' })}>
      {formatRelativeTime(at, now)}
    </time>
  );
}

export function TaskHistoryDuration({
  startedAt,
  finishedAt,
}: {
  startedAt: string;
  finishedAt: string | null;
}) {
  useI18n();
  const now = useNow(1000, !finishedAt);
  const label = elapsedLabel(startedAt, finishedAt ? Date.parse(finishedAt) : now);
  return label ? <span className="task-history-duration">{label}</span> : null;
}

export function TaskStatusBadge({ tone, label }: { tone: StatusTone; label: string }) {
  const Glyph = statusGlyph[tone];
  return (
    <span className={`task-status-badge task-status-badge-${tone}`} data-tone={tone}>
      <Glyph
        size={14}
        aria-hidden="true"
        className={tone === 'running' ? 'activity-spinner' : undefined}
      />
      {label}
    </span>
  );
}

export function TaskHistoryFilters({
  value,
  counts,
  onChange,
}: {
  value: TaskHistoryFilter;
  counts: Record<TaskHistoryFilter, number>;
  onChange: (value: TaskHistoryFilter) => void;
}) {
  useI18n();
  const labels: Record<TaskHistoryFilter, string> = {
    all: t('chatsettings.taskHistoryAll'),
    running: t('chatsettings.taskHistoryRunning'),
    issue: t('chatsettings.taskHistoryIssue'),
  };
  return (
    <div
      className="segmented task-history-filters"
      role="group"
      aria-label={t('chatsettings.taskHistoryFilter')}
    >
      {(['all', 'running', 'issue'] as const).map((filter) => (
        <button
          key={filter}
          type="button"
          aria-pressed={value === filter}
          onClick={() => onChange(filter)}
        >
          <span>{labels[filter]}</span>{' '}
          <span className="task-history-filter-count">{formatNumber(counts[filter])}</span>
        </button>
      ))}
    </div>
  );
}

export type TaskHistoryTotal = { amount: number; partial: boolean; empty: boolean };

export function sumTaskHistoryValues(
  values: (number | null | undefined)[],
  partial = false
): TaskHistoryTotal {
  const known = values.filter((value): value is number => value != null);
  return {
    amount: known.reduce((total, value) => total + value, 0),
    partial: partial || known.length < values.length,
    empty: !known.length,
  };
}

export function taskHistoryTotalLabel(
  value: TaskHistoryTotal,
  format: (amount: number) => string,
  formatSubtotal = format
) {
  if (value.empty) return t('visualpanels.unknown');
  return value.partial
    ? t('chatsettings.taskHistoryAtLeast', { value: formatSubtotal(value.amount) })
    : format(value.amount);
}

export function TaskHistorySummary({ items }: { items: { label: string; value: ReactNode }[] }) {
  useI18n();
  return (
    <dl className="task-history-summary" aria-label={t('chatsettings.taskHistorySummary')}>
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TaskHistoryRow({
  tone,
  statusLabel,
  request,
  meta = [],
  notice,
  actions,
  focused = false,
  dataProps,
  children,
}: {
  tone: StatusTone;
  statusLabel: string;
  request: string;
  meta?: { key: string; value: ReactNode }[];
  notice?: ReactNode;
  actions?: ReactNode;
  focused?: boolean;
  dataProps?: Record<string, string>;
  children: ReactNode;
}) {
  useI18n();
  const id = useId();
  const [expanded, setExpanded] = useState(focused);
  useEffect(() => {
    setExpanded(focused);
  }, [focused]);
  const shownMeta = meta.filter((item) => item.value);
  return (
    <article className={`task-history-row task-history-row-${tone}`} {...dataProps}>
      <div className="task-history-row-head">
        <TaskStatusBadge tone={tone} label={statusLabel} />
        {shownMeta.length > 0 && (
          <span className="ui-meta-row task-history-meta">
            {shownMeta.map((item) => (
              <span key={item.key}>{item.value}</span>
            ))}
          </span>
        )}
      </div>
      <p className="task-request task-history-request" data-clamped={expanded ? undefined : ''}>
        {request}
      </p>
      {notice && <div className="task-history-notice">{notice}</div>}
      <div className="task-history-row-actions">
        {actions}
        <button
          type="button"
          className="secondary task-history-toggle"
          aria-expanded={expanded}
          aria-controls={`${id}-detail`}
          onClick={() => setExpanded((old) => !old)}
        >
          <DropdownIcon size={16} aria-hidden="true" />
          {expanded ? t('chatsettings.taskHistoryCollapse') : t('chatsettings.taskHistoryExpand')}
        </button>
      </div>
      <div id={`${id}-detail`} className="task-history-detail" hidden={!expanded}>
        {expanded && children}
      </div>
    </article>
  );
}

export function TaskHistorySection({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="task-history-section" aria-labelledby={id}>
      <div className="task-history-section-head">
        <h3 id={id}>{title}</h3>
        {actions && <div className="task-history-section-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export type TaskHistoryStep = {
  key: string | number;
  tone: StatusTone;
  stateLabel: string;
  label: string;
  meta?: ReactNode[];
  children?: ReactNode;
};

export function TaskHistoryTimeline({ steps }: { steps: TaskHistoryStep[] }) {
  return (
    <ol className="task-history-timeline">
      {steps.map((step) => {
        const Glyph = statusGlyph[step.tone];
        const meta = (step.meta ?? []).filter(Boolean);
        return (
          <li key={step.key} data-tone={step.tone}>
            <div className="task-history-step-head">
              <Glyph
                size={14}
                aria-hidden="true"
                className={step.tone === 'running' ? 'activity-spinner' : undefined}
              />
              <span className="task-history-step-label">{step.label}</span>
              <span className="sr-only">{step.stateLabel}</span>
              {meta.length > 0 && (
                <span className="ui-meta-row task-history-step-meta">
                  {meta.map((item, index) => (
                    <span key={index}>{item}</span>
                  ))}
                </span>
              )}
            </div>
            {step.children}
          </li>
        );
      })}
    </ol>
  );
}

export function CopyTextButton({
  text,
  label,
  copiedLabel,
  onFailure,
}: {
  text: () => string;
  label: string;
  copiedLabel: string;
  onFailure: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text());
          setCopied(true);
        } catch {
          setCopied(false);
          onFailure();
        }
      }}
    >
      <CopyIcon size={16} aria-hidden="true" />
      {copied ? copiedLabel : label}
    </button>
  );
}
