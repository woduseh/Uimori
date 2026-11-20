import { t, useI18n } from './i18n.js';
import { useState, type ReactNode } from 'react';
import { DoneIcon, IssueIcon, RunningIcon, StopIcon, UncertainIcon } from './ui-icons.js';
import './turn-activity.css';
import './activity-status.css';

export type StatusTone = 'running' | 'done' | 'cancelled' | 'issue' | 'uncertain';
export const statusGlyph = {
  running: RunningIcon,
  done: DoneIcon,
  cancelled: StopIcon,
  issue: IssueIcon,
  uncertain: UncertainIcon,
} as const;

type Props = {
  tone: StatusTone;
  text: string;
  elapsed?: ReactNode;
  leading?: ReactNode;
  badges?: ReactNode;
  quiet?: boolean;
  issue?: boolean;
  storageKey?: string;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  dataProps?: Record<string, string>;
};

export function TurnStatus({
  tone,
  text,
  elapsed,
  leading,
  badges,
  quiet = false,
  issue = tone === 'issue',
  storageKey,
  onOpenChange,
  children,
  dataProps,
}: Props) {
  useI18n();
  const [open, setOpen] = useState(() => {
    try {
      return !!storageKey && sessionStorage.getItem(storageKey) === 'open';
    } catch {
      return false;
    }
  });
  const [visited, setVisited] = useState(open);
  const Glyph = statusGlyph[tone];
  const className = `turn-activity${issue ? ' turn-activity-issue' : ''}`;
  const lead = (
    <span className="turn-activity-lead">
      {leading}
      <span className={`turn-status turn-status-${tone}`} aria-hidden="true">
        <Glyph size={15} className={tone === 'running' ? 'activity-spinner' : undefined} />
      </span>
      <span className={quiet ? 'sr-only' : 'turn-activity-text'}>
        {quiet ? t('helpers.m247', { v0: text }) : text}
      </span>
      {elapsed && <small>{elapsed}</small>}
      {badges}
    </span>
  );
  const persist = (next: boolean) => {
    setOpen(next);
    if (next) setVisited(true);
    onOpenChange?.(next);
    try {
      if (storageKey) sessionStorage.setItem(storageKey, next ? 'open' : 'closed');
    } catch {}
  };
  return (
    <details
      className={className}
      {...dataProps}
      open={open}
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return;
        persist(event.currentTarget.open);
      }}
    >
      <summary
        onClick={(event) => {
          // The browser fires the details toggle event asynchronously: a reload right after closing
          // would bring the panel back, and React's controlled attribute would double-toggle it.
          event.preventDefault();
          persist(!open);
        }}
      >
        {lead}
      </summary>
      {visited && <div className="turn-activity-body">{children}</div>}
    </details>
  );
}
