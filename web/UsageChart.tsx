import { useState } from 'react';
import type { UsageReport } from '../core/usage-report.js';
import { bucketLabel, shortDay, usageBuckets, usageUsd } from './usage-display.js';

export function UsageChart({ report }: { report: UsageReport }) {
  const { step, buckets } = usageBuckets(report);
  const [selected, setSelected] = useState<number | null>(null);
  const maximum = Math.max(0, ...buckets.map((item) => item.amount));
  const current = selected === null ? undefined : buckets[selected];
  return (
    <section className="usage-trend" aria-label="비용 추이">
      <header className="usage-section-heading">
        <h3>비용 추이</h3>
        <small>{step === 1 ? '일별' : `${step}일 단위`} · 한국 시간</small>
      </header>
      <div className="usage-chart-scale">
        <span>{usageUsd(maximum)}</span>
        <span>US$0</span>
      </div>
      <div className="usage-chart" aria-label="기간별 비용">
        {buckets.map((item, index) => (
          <button
            key={item.from}
            type="button"
            className={`usage-chart-column${item.unknown || item.partial ? ' incomplete' : ''}`}
            aria-label={bucketLabel(item)}
            aria-pressed={selected === index}
            title={bucketLabel(item)}
            onPointerEnter={() => setSelected(index)}
            onFocus={() => setSelected(index)}
            onClick={() => setSelected(index)}
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
      <p className="usage-chart-caption" aria-live="polite">
        {current ? bucketLabel(current) : '막대를 선택하면 상세 내역을 볼 수 있어요.'}
      </p>
    </section>
  );
}
