import type { CSSProperties } from 'react';
import { Gauge } from 'lucide-react';
import {
  HELPER_COMPACTION_INPUT_RATIO,
  type HelperInputParts,
  type HelperTaskResultsView,
} from '../core/helper.js';
import { ActionMenu } from './ActionMenu.js';
import { formatNumber, t, useI18n } from './i18n.js';
import { usageCompact } from './usage-display.js';
import './helper-context-usage.css';

const parts: (keyof HelperInputParts)[] = [
  'instructions',
  'toolSchemas',
  'history',
  'source',
  'toolResults',
];

export function HelperContextUsage({ usage }: { usage: HelperTaskResultsView['usage'] }) {
  useI18n();
  const native = usage.latestInputExecution === 'codex-native';
  const reported = usage.latestInputTokens ?? null;
  const estimate = native ? null : usage.latestInputEstimate;
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
    estimate !== null && limit
      ? t('helperUsage.estimateValue', {
          input: formatNumber(estimate),
          limit: formatNumber(limit),
        })
      : text
  }`;
  const value = (amount: number | null | undefined) =>
    amount == null ? t('helperResults.unknown') : formatNumber(amount);
  return (
    <ActionMenu
      className="helper-context-usage"
      placement="top"
      viewport
      label={label}
      summary={
        <span
          className="helper-context-usage-summary"
          data-level={level}
          data-unknown={unknown || undefined}
        >
          {unknown && <Gauge size={16} aria-hidden="true" className="helper-context-usage-icon" />}
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
              {parts.map((part) => (
                <div key={part} className="helper-context-usage-row">
                  <dt>{t(`helperUsage.${part}`)}</dt>
                  <dd>{value(usage.latestInputParts?.[part])}</dd>
                </div>
              ))}
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
            </>
          )}
        </dl>
        <p>{t(native ? 'helperUsage.nativeNote' : 'helperUsage.estimateNote')}</p>
      </div>
    </ActionMenu>
  );
}
