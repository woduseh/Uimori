import { t, useI18n, formatNumber } from './i18n.js';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { ReactNode } from 'react';
import { statusGlyph, type StatusTone } from './TurnStatus.js';
import './activity-status.css';

type Props = {
  tone: StatusTone;
  issue: boolean;
  label: string;
  elapsed?: ReactNode;
  extra?: number;
  expanded: boolean;
  collapsed: boolean;
  toggleLabel: string;
  toggleTitle: string;
  onToggle: () => void;
  onDetails: () => void;
  testId?: string;
};

export function ActivityBar({
  tone,
  issue,
  label,
  elapsed,
  extra = 0,
  expanded,
  collapsed,
  toggleLabel,
  toggleTitle,
  onToggle,
  onDetails,
  testId,
}: Props) {
  useI18n();
  const Glyph = statusGlyph[tone];
  return (
    <div className={`activity-status ${issue ? 'activity-issue' : ''}`} data-testid={testId}>
      <span className="sr-only" role="status" aria-live="polite">
        {label}
      </span>
      <button
        type="button"
        className="activity-toggle"
        aria-label={toggleLabel}
        aria-expanded={expanded}
        title={toggleTitle}
        onClick={onToggle}
      >
        <Glyph
          size={16}
          aria-hidden="true"
          className={tone === 'running' ? 'activity-spinner' : ''}
        />
        <span className="activity-label">{label}</span>
        {elapsed && (
          <span className="activity-elapsed" aria-hidden="true">
            {elapsed}
          </span>
        )}
        {extra > 0 && (
          <span className="activity-count">
            {t('helpers.m329', { count: formatNumber(extra) })}
          </span>
        )}
        {collapsed ? (
          <ChevronUp size={14} aria-hidden="true" />
        ) : (
          <ChevronDown size={14} aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        className="activity-details"
        onClick={onDetails}
        aria-label={t('helpers.m245')}
      >
        {t('helpers.m246')}
      </button>
    </div>
  );
}
