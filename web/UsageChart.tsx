import { t, useI18n } from './i18n.js';
import { useState } from 'react';
import type { UsageReport } from '../core/usage-report.js';
import { bucketLabel, shortDay, usageBuckets, usageUsd } from './usage-display.js';

export function UsageChart({ report }: { report: UsageReport }) {
  useI18n();
  const { step, buckets } = usageBuckets(report);
  const [selected, setSelected] = useState<{ range: string; from: string } | null>(null);
  const range = `${report.from}/${report.to}`;
  const maximum = Math.max(0, ...buckets.map((item) => item.amount));
  const current =
    buckets.find((item) => selected?.range === range && item.from === selected.from) ??
    buckets.findLast((item) => item.calls > 0) ??
    buckets.at(-1);
  return (
    <section className="usage-trend" aria-label={t('visuals.m260')}>
      <header className="usage-section-heading">
        <h3>{t('visuals.m260')}</h3>
        <small>{t('visuals.chartPeriod', { step })}</small>
      </header>
      {report.totals.calls === 0 ? (
        <p className="usage-chart-empty" role="status">
          {t('visuals.m264')}
        </p>
      ) : (
        <>
          <div className="usage-chart-scale">
            <span>{usageUsd(maximum)}</span>
            <span>US$0</span>
          </div>
          <div className="usage-chart" aria-label={t('visuals.m265')}>
            {buckets.map((item) => (
              <button
                key={item.from}
                type="button"
                className={`usage-chart-column${item.unknown || item.partial ? ' incomplete' : ''}`}
                aria-label={bucketLabel(item)}
                aria-pressed={current === item}
                title={bucketLabel(item)}
                onPointerEnter={() => setSelected({ range, from: item.from })}
                onFocus={() => setSelected({ range, from: item.from })}
                onClick={() => setSelected({ range, from: item.from })}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                  event.preventDefault();
                  const next =
                    event.key === 'ArrowLeft'
                      ? event.currentTarget.previousElementSibling
                      : event.currentTarget.nextElementSibling;
                  if (next instanceof HTMLButtonElement) next.focus();
                }}
              >
                <span
                  className="usage-chart-bar"
                  style={{
                    height: `${maximum && item.amount ? Math.max(2, (item.amount / maximum) * 100) : 0}%`,
                  }}
                />
                {(item.unknown > 0 || item.partial > 0) && (
                  <span className="usage-chart-missing" aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
          <div className="usage-chart-axis">
            <span>{shortDay(report.from)}</span>
            {report.from !== report.to && <span>{shortDay(report.to)}</span>}
          </div>
          {current && (
            <p className="usage-chart-caption" aria-live="polite">
              {bucketLabel(current)}
            </p>
          )}
        </>
      )}
    </section>
  );
}
