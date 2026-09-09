import { ChevronDown, ChevronUp } from 'lucide-react';
import { statusGlyph, type StatusTone } from './TurnStatus.js';
import './activity-status.css';

type Props = {
  tone: StatusTone;
  /** Issue colouring, kept separate so an unconfirmed execution can read as a problem. */
  issue: boolean;
  label: string;
  /** Elapsed or measured duration; omitted when there is nothing meaningful to show. */
  elapsed?: string;
  /** Tasks represented beyond the summarized one. */
  extra?: number;
  /** Whether the control the toggle governs is open. */
  expanded: boolean;
  /** The summary itself is hidden, so the toggle brings it back. */
  collapsed: boolean;
  toggleLabel: string;
  toggleTitle: string;
  onToggle: () => void;
  onDetails: () => void;
  testId?: string;
};

/** Compact progress row above a composer. Hiding never changes or cancels server work. */
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
        {extra > 0 && <span className="activity-count">외 {extra}개</span>}
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
        aria-label="작업 상세 보기"
      >
        상세
      </button>
    </div>
  );
}
