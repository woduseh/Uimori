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

export function HelperContextUsage({
  usage,
  context,
  busy = false,
  starting = false,
  compactError = '',
  onCompact,
  onCancel,
}: {
  usage: HelperTaskResultsView['usage'];
  context?: HelperContextCompactionSummary;
  busy?: boolean;
  starting?: boolean;
  compactError?: string;
  onCompact?: () => void;
  onCancel?: () => void;
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
  const estimate =
    measured !== null && compacted
      ? Math.max(compacted.afterTokens, measured - compacted.beforeTokens + compacted.afterTokens)
      : measured;
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
  const failureText = compactError
    ? translateMessage(compactError)
    : failure
      ? t(`errors.${failure}`)
      : '';
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
            {share !== null && (
              <span
                className="helper-context-usage-bar"
                aria-hidden="true"
                style={
                  {
                    '--usage-share': Math.min(1, share),
                    '--usage-threshold': HELPER_COMPACTION_INPUT_RATIO,
                  } as CSSProperties
                }
              />
            )}
          </span>
        )
      }
    >
      <div className="helper-context-usage-body">
        <strong>{t('helperUsage.label')}</strong>
        <dl>
          {native ? (
            <div className="helper-context-usage-row">
              <dt>{t('helperUsage.reported')}</dt>
              <dd>{value(reported)}</dd>
            </div>
          ) : (
            <>
              {compacted ? (
                <>
                  <div className="helper-context-usage-row">
                    <dt>{t('helperUsage.beforeCompaction')}</dt>
                    <dd>{formatNumber(compacted.beforeTokens)}</dd>
                  </div>
                  <div className="helper-context-usage-row">
                    <dt>{t('helperUsage.afterCompaction')}</dt>
                    <dd>{formatNumber(compacted.afterTokens)}</dd>
                  </div>
                </>
              ) : (
                parts.map((part) => (
                  <div key={part} className="helper-context-usage-row">
                    <dt>{t(`helperUsage.${part}`)}</dt>
                    <dd>{value(usage.latestInputParts?.[part])}</dd>
                  </div>
                ))
              )}
              <div className="helper-context-usage-row helper-context-usage-total">
                <dt>{t('helperUsage.total')}</dt>
                <dd>{value(estimate)}</dd>
              </div>
              <div className="helper-context-usage-row">
                <dt>{t('helperUsage.limit')}</dt>
                <dd>{value(limit)}</dd>
              </div>
              {threshold !== null && (
                <div className="helper-context-usage-row">
                  <dt>{t('helperUsage.threshold')}</dt>
                  <dd>{formatNumber(threshold)}</dd>
                </div>
              )}
              {context && context.compactedMessages > 0 && (
                <div className="helper-context-usage-row">
                  <dt>{t('helperUsage.compacted')}</dt>
                  <dd>{t('helperUsage.compactedCount', { count: context.compactedMessages })}</dd>
                </div>
              )}
            </>
          )}
        </dl>
        <p>
          {t(
            native
              ? 'helperUsage.nativeNote'
              : compacted
                ? 'helperUsage.compactedNote'
                : 'helperUsage.estimateNote'
          )}
        </p>
        {!native && onCompact && (
          <div className="helper-context-usage-actions">
            <button
              type="button"
              className="secondary"
              data-keep-open=""
              disabled={compacting || busy || (context ? context.uncompactedMessages === 0 : false)}
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
          </div>
        )}
      </div>
    </ActionMenu>
  );
}
