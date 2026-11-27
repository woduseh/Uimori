import { Gauge } from 'lucide-react';
import {
  HELPER_COMPACTION_INPUT_RATIO,
  type HelperContextCompactionSummary,
  type HelperInputParts,
  type HelperTaskResultsView,
} from '../core/helper.js';
import { ActionMenu } from './ActionMenu.js';
import {
  ContextBar,
  ContextTable,
  type ContextNote,
  type ContextSegment,
  type ContextTone,
} from './ContextBreakdown.js';
import { formatNumber, t, useI18n } from './i18n.js';
import { formatUiMessage, type UiMessage } from './ui-message.js';
import { RunningIcon } from './ui-icons.js';
import { usageCompact } from './usage-display.js';
import './activity-status.css';
import './helper-context-usage.css';

export const helperInputTones: Record<keyof HelperInputParts, ContextTone> = {
  instructions: 'instructions',
  toolSchemas: 'tools',
  history: 'history',
  source: 'reference',
  toolResults: 'results',
};
const parts = Object.keys(helperInputTones) as (keyof HelperInputParts)[];

export function helperInputBreakdown(
  inputParts: HelperInputParts | null | undefined,
  estimate: number | null,
  adjust: (part: keyof HelperInputParts, tokens: number) => number = (_part, tokens) => tokens
) {
  const rows = parts.map((part) => {
    const amount = inputParts?.[part] ?? null;
    return {
      key: part,
      label: t(`helperUsage.${part}`),
      tokens: amount === null ? null : adjust(part, amount),
      tone: helperInputTones[part],
    };
  });
  const known = rows.flatMap((row) => (row.tokens === null ? [] : [row.tokens]));
  const other =
    estimate === null ? null : Math.max(0, estimate - known.reduce((sum, value) => sum + value, 0));
  const otherRow = {
    key: 'other',
    label: t('contextBreakdown.other'),
    tone: 'other' as const,
  };
  const segments: ContextSegment[] = [
    ...rows.flatMap((row) => (row.tokens ? [{ ...row, tokens: row.tokens }] : [])),
    ...(other ? [{ ...otherRow, tokens: other }] : []),
  ];
  return {
    rows:
      other !== null && other > 0 && known.length > 0
        ? [...rows, { ...otherRow, tokens: other }]
        : rows,
    segments,
  };
}

export function HelperContextUsage({
  usage,
  context,
  busy = false,
  starting = false,
  compactError = null,
  onCompact,
  onCancel,
  onShowSummary,
}: {
  usage: HelperTaskResultsView['usage'];
  context?: HelperContextCompactionSummary;
  busy?: boolean;
  starting?: boolean;
  compactError?: UiMessage | null;
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
  const { rows, segments } = helperInputBreakdown(
    usage.latestInputParts,
    estimate,
    (part, tokens) => (part === 'history' ? afterCompaction(tokens) : tokens)
  );
  const bar =
    limit && estimate !== null && threshold !== null ? (
      <ContextBar segments={segments} total={estimate} limit={limit} threshold={threshold} />
    ) : null;
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
  const compactable = !native && Boolean(onCompact);
  const showSummary = Boolean(onShowSummary) && (context?.summaryChars ?? 0) > 0;
  const failureText = compactError
    ? formatUiMessage(compactError)
    : failure
      ? t(`errors.${failure}`)
      : '';
  const notes: ContextNote[] = [
    ...(compacted && !compacted.origin
      ? [
          {
            key: 'before',
            label: t('helperUsage.beforeCompaction'),
            value: formatNumber(compacted.beforeTokens),
          },
          {
            key: 'after',
            label: t('helperUsage.afterCompaction'),
            value: formatNumber(compacted.afterTokens),
          },
        ]
      : []),
    ...(context && context.compactedMessages > 0
      ? [
          {
            key: 'compacted',
            label: t('helperUsage.compacted'),
            value: t('helperUsage.compactedCount', { count: context.compactedMessages }),
          },
        ]
      : []),
  ];
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
            {bar}
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
                  {formatNumber(share, { style: 'percent', maximumFractionDigits: 1 })}
                </span>
              )}
            </span>
          )}
        </div>
        {bar}
        {native ? (
          <ContextTable
            label={t('helperUsage.label')}
            rows={[{ key: 'reported', label: t('helperUsage.reported'), tokens: reported }]}
            limit={null}
          />
        ) : (
          <ContextTable
            label={t('helperUsage.label')}
            rows={rows}
            total={estimate}
            limit={limit}
            threshold={threshold}
            notes={notes}
          />
        )}
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
