import type { CSSProperties } from 'react';
import { Gauge } from 'lucide-react';
import {
  HELPER_COMPACTION_INPUT_RATIO,
  type HelperContextCompactionSummary,
  type HelperInputParts,
  type HelperTaskResultsView,
} from '../core/helper.js';
import { ActionMenu } from './ActionMenu.js';
import { formatNumber, t, translateMessage, useI18n } from './i18n.js';
import { RunningIcon } from './ui-icons.js';
import { usageCompact } from './usage-display.js';
import './activity-status.css';
import './helper-context-usage.css';

const parts: (keyof HelperInputParts)[] = [
  'instructions',
  'toolSchemas',
  'history',
  'source',
  'toolResults',
];

type Segment = { part: keyof HelperInputParts | 'other'; tokens: number };

function UsageBar({
  segments,
  scale,
  threshold,
}: {
  segments: Segment[];
  scale: number;
  threshold: number;
}) {
  return (
    <span
      className="helper-context-usage-bar"
      aria-hidden="true"
      style={{ '--usage-threshold': threshold / scale } as CSSProperties}
    >
      {segments.map(({ part, tokens }) => (
        <span
          key={part}
          className="helper-context-usage-segment"
          data-part={part}
          style={{ '--part-share': tokens / scale } as CSSProperties}
        />
      ))}
    </span>
  );
}

export function HelperContextUsage({
  usage,
  context,
  busy = false,
  starting = false,
  compactError = '',
  onCompact,
  onCancel,
  onShowSummary,
}: {
  usage: HelperTaskResultsView['usage'];
  context?: HelperContextCompactionSummary;
  busy?: boolean;
  starting?: boolean;
  compactError?: string;
  onCompact?: () => void;
  onCancel?: () => void;
  onShowSummary?: () => void;
}) {
  useI18n();
  const running = Boolean(context?.compaction.running);
  const compacting = starting || running;
  const last = compacting ? null : (context?.compaction.last ?? null);
  const compacted = last?.status === 'completed' ? last : null;
  const failure = last?.status === 'failed' ? last.code : null;
  const native = usage.latestInputExecution === 'codex-native';
  const reported = usage.latestInputTokens ?? null;
  const measured = native ? null : usage.latestInputEstimate;
  const afterCompaction = (amount: number) =>
    compacted
      ? Math.max(compacted.afterTokens, amount - compacted.beforeTokens + compacted.afterTokens)
      : amount;
  const estimate = measured === null ? null : afterCompaction(measured);
  const limit = native ? null : (usage.latestInputLimit ?? null);
  const share = estimate !== null && limit ? estimate / limit : null;
  const threshold = limit ? Math.floor(limit * HELPER_COMPACTION_INPUT_RATIO) : null;
  const level =
    share === null
      ? undefined
      : share >= 1
        ? 'over'
        : share >= HELPER_COMPACTION_INPUT_RATIO
          ? 'near'
          : undefined;
  const rows = parts.map((part) => {
    const amount = usage.latestInputParts?.[part] ?? null;
    return {
      part,
      tokens: part === 'history' && amount !== null ? afterCompaction(amount) : amount,
    };
  });
  const known = rows.flatMap((row) => (row.tokens === null ? [] : [row.tokens]));
  const other =
    estimate === null ? null : Math.max(0, estimate - known.reduce((sum, value) => sum + value, 0));
  const segments: Segment[] = [
    ...rows.flatMap(({ part, tokens }) => (tokens ? [{ part, tokens }] : [])),
    ...(other ? [{ part: 'other' as const, tokens: other }] : []),
  ];
  const scale = limit && estimate !== null ? Math.max(limit, estimate) : null;
  const unknown = estimate === null && !(native && reported !== null);
  const text =
    estimate !== null
      ? t('helperUsage.summary', { count: usageCompact(estimate) })
      : native && reported !== null
        ? t('helperUsage.summaryExact', { count: usageCompact(reported) })
        : t('helperUsage.unknown');
  const shortText =
    estimate !== null
      ? t('helperUsage.summaryShort', { count: usageCompact(estimate) })
      : native && reported !== null
        ? usageCompact(reported)
        : null;
  const label = `${t('helperUsage.label')}: ${
    compacting
      ? t('helperUsage.compacting')
      : estimate !== null && limit
        ? t('helperUsage.estimateValue', {
            input: formatNumber(estimate),
            limit: formatNumber(limit),
          })
        : text
  }`;
  const value = (amount: number | null | undefined) =>
    amount == null ? t('helperResults.unknown') : formatNumber(amount);
  const percent = (amount: number | null) =>
    amount === null || !limit
      ? ''
      : formatNumber(amount / limit, { style: 'percent', maximumFractionDigits: 1 });
  const compactable = !native && Boolean(onCompact);
  const showSummary = Boolean(onShowSummary) && (context?.summaryChars ?? 0) > 0;
  const failureText = compactError
    ? translateMessage(compactError)
    : failure
      ? t(`errors.${failure}`)
      : '';
  const row = (name: string, amount: string, part?: string, shareText = '', className?: string) => (
    <tr key={name} className={className}>
      <th scope="row">
        <span className="helper-context-usage-name">
          <span className="helper-context-usage-key" data-part={part} aria-hidden="true" />
          {name}
        </span>
      </th>
      <td>{amount}</td>
      {limit !== null && <td>{shareText}</td>}
    </tr>
  );
  return (
    <ActionMenu
      className="helper-context-usage"
      placement="top"
      viewport
      label={label}
      summary={
        compacting ? (
          <span className="helper-context-usage-summary helper-context-usage-compacting">
            <RunningIcon size={14} aria-hidden="true" className="activity-spinner" />
            <span>{t('helperUsage.compactingShort')}</span>
          </span>
        ) : (
          <span
            className="helper-context-usage-summary"
            data-level={level}
            data-unknown={unknown || undefined}
          >
            {unknown && (
              <Gauge size={16} aria-hidden="true" className="helper-context-usage-icon" />
            )}
            <span className="helper-context-usage-text">{text}</span>
            {shortText && <span className="helper-context-usage-short">{shortText}</span>}
            {scale !== null && threshold !== null && (
              <UsageBar segments={segments} scale={scale} threshold={threshold} />
            )}
          </span>
        )
      }
    >
      <div className="helper-context-usage-body">
        <div className="helper-context-usage-head">
          <strong>{t('helperUsage.label')}</strong>
          {estimate !== null && (
            <span className="helper-context-usage-headline">
              <span>
                {limit
                  ? t('helperUsage.headline', {
                      input: usageCompact(estimate),
                      limit: usageCompact(limit),
                    })
                  : t('helperUsage.headlineNoLimit', { input: usageCompact(estimate) })}
              </span>
              {share !== null && (
                <span className="helper-context-usage-percent" data-level={level}>
                  {percent(estimate)}
                </span>
              )}
            </span>
          )}
        </div>
        {scale !== null && threshold !== null && (
          <UsageBar segments={segments} scale={scale} threshold={threshold} />
        )}
        <table className="helper-context-usage-table" aria-label={t('helperUsage.label')}>
          <thead className="sr-only">
            <tr>
              <th scope="col">{t('helperUsage.columnPart')}</th>
              <th scope="col">{t('helperUsage.columnTokens')}</th>
              {limit !== null && <th scope="col">{t('helperUsage.columnShare')}</th>}
            </tr>
          </thead>
          {native ? (
            <tbody>{row(t('helperUsage.reported'), value(reported))}</tbody>
          ) : (
            <>
              <tbody>
                {rows.map(({ part, tokens }) =>
                  row(t(`helperUsage.${part}`), value(tokens), part, percent(tokens))
                )}
                {other !== null &&
                  other > 0 &&
                  known.length > 0 &&
                  row(t('helperUsage.other'), formatNumber(other), 'other', percent(other))}
              </tbody>
              <tbody>
                {row(
                  t('helperUsage.total'),
                  value(estimate),
                  undefined,
                  percent(estimate),
                  'helper-context-usage-total'
                )}
                {limit !== null &&
                  estimate !== null &&
                  row(
                    t('helperUsage.free'),
                    formatNumber(Math.max(0, limit - estimate)),
                    'free',
                    percent(Math.max(0, limit - estimate))
                  )}
                {(limit === null || estimate === null) && row(t('helperUsage.limit'), value(limit))}
                {threshold !== null &&
                  row(
                    t('helperUsage.threshold'),
                    formatNumber(threshold),
                    'threshold',
                    percent(threshold)
                  )}
                {compacted &&
                  !compacted.origin &&
                  row(t('helperUsage.beforeCompaction'), formatNumber(compacted.beforeTokens))}
                {compacted &&
                  !compacted.origin &&
                  row(t('helperUsage.afterCompaction'), formatNumber(compacted.afterTokens))}
                {context &&
                  context.compactedMessages > 0 &&
                  row(
                    t('helperUsage.compacted'),
                    t('helperUsage.compactedCount', { count: context.compactedMessages })
                  )}
              </tbody>
            </>
          )}
        </table>
        {(native || compacted) && (
          <p>
            {t(
              native
                ? 'helperUsage.nativeNote'
                : compacted?.origin
                  ? 'helperUsage.summaryChangedNote'
                  : 'helperUsage.compactedNote'
            )}
          </p>
        )}
        {(compactable || showSummary) && (
          <div className="helper-context-usage-actions">
            {compactable && (
              <>
                <button
                  type="button"
                  className="secondary"
                  data-keep-open=""
                  disabled={
                    compacting || busy || (context ? context.uncompactedMessages === 0 : false)
                  }
                  onClick={onCompact}
                >
                  {compacting && (
                    <RunningIcon size={16} aria-hidden="true" className="activity-spinner" />
                  )}
                  {t(compacting ? 'helperUsage.compacting' : 'helperUsage.compactNow')}
                </button>
                {running && onCancel && (
                  <button type="button" className="secondary" data-keep-open="" onClick={onCancel}>
                    {t('helperUsage.cancelCompaction')}
                  </button>
                )}
                {!compacting && busy && <p>{t('helperUsage.compactBusyHint')}</p>}
                {!compacting &&
                  !busy &&
                  context &&
                  context.totalMessages > 0 &&
                  context.uncompactedMessages === 0 && <p>{t('helperUsage.alreadyCompacted')}</p>}
                {failureText &&
                  (failure === 'HELPER_COMPACTION_CANCELLED' && !compactError ? (
                    <p>{failureText}</p>
                  ) : (
                    <p className="helper-context-usage-error" role="alert">
                      {failureText}
                    </p>
                  ))}
              </>
            )}
            {showSummary && (
              <button
                type="button"
                className="secondary"
                onClick={(event) => {
                  const menu = event.currentTarget.closest('details');
                  if (menu) {
                    menu.open = false;
                    menu.querySelector<HTMLElement>(':scope > summary')?.focus();
                  }
                  onShowSummary?.();
                }}
              >
                {t('helperUsage.showSummary')}
              </button>
            )}
          </div>
        )}
      </div>
    </ActionMenu>
  );
}
