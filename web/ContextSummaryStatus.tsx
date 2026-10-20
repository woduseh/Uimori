import { t, translateMessage, useI18n, formatNumber } from './i18n.js';
import type { ReaderRun } from '../core/types.js';
import './context-summary.css';

export function ContextSummaryStatus({ summary }: { summary: ReaderRun['contextSummary'] }) {
  useI18n();
  if (!summary) return null;
  return (
    <aside
      className={`context-summary${summary.status === 'failed' ? ' context-summary-error' : ''}`}
      data-testid="context-summary"
      data-context-status={summary.status}
      aria-label={t('settings.m315')}
      role={summary.status === 'failed' ? 'alert' : 'status'}
    >
      {summary.status === 'pending' ? (
        <span>{t('settings.m316')}</span>
      ) : summary.status === 'failed' ? (
        <>
          <strong>{t('settings.m317')}</strong>
          <span>{summary.error ? translateMessage(summary.error) : t('settings.m318')}</span>
        </>
      ) : (
        <span>
          {t('settings.contextReady', {
            compacted: summary.compactedSources > 0 ? 'yes' : 'no',
            sources: formatNumber(summary.compactedSources),
            known: summary.estimatedInputTokens === null ? 'no' : 'yes',
            input: formatNumber(summary.estimatedInputTokens ?? 0),
            limit: formatNumber(summary.inputTokenLimit),
            summarized: summary.compactedSources > 0 || summary.summaryCalls > 0 ? 'yes' : 'no',
            calls: formatNumber(summary.summaryCalls),
          })}
        </span>
      )}
    </aside>
  );
}
