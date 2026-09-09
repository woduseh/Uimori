import { useState, type ReactNode } from 'react';
import { DoneIcon, IssueIcon, RunningIcon, UncertainIcon } from './ui-icons.js';
import './turn-activity.css';

/** Progress vocabulary shared by the main reader and the helper conversation. */
export type StatusTone = 'running' | 'done' | 'issue' | 'uncertain';
export const statusGlyph = {
  running: RunningIcon,
  done: DoneIcon,
  issue: IssueIcon,
  uncertain: UncertainIcon,
} as const;

type Props = {
  tone: StatusTone;
  /** Status sentence. It stays available to assistive technology even when `quiet`. */
  text: string;
  /** Elapsed or measured duration; omitted when there is nothing meaningful to show. */
  elapsed?: string;
  /** Scene number and other identity rendered before the glyph. */
  leading?: ReactNode;
  /** Badges shown after the status text, such as a manual-translation marker. */
  badges?: ReactNode;
  /** A settled response shows only the glyph; the sentence moves to assistive technology. */
  quiet?: boolean;
  /** Keeps the issue colour when a connection check hides the underlying failure. */
  issue?: boolean;
  /** Session key that restores the disclosure state after a reload. */
  storageKey?: string;
  onOpenChange?: (open: boolean) => void;
  /** Diagnostics revealed by the disclosure. */
  children: ReactNode;
  dataProps?: Record<string, string>;
};

/** Status row with the shared glyph, sentence, duration and optional diagnostics. */
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
        <Glyph size={15} />
      </span>
      <span className={quiet ? 'sr-only' : 'turn-activity-text'}>
        {quiet ? `작업 현황 · ${text}` : text}
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
    } catch {
      /* Current view still works. */
    }
  };
  return (
    <details
      className={className}
      {...dataProps}
      open={open}
      onToggle={(event) => {
        // Nested diagnostic disclosures must not change this response's state.
        if (event.target !== event.currentTarget) return;
        persist(event.currentTarget.open);
      }}
    >
      <summary
        onClick={(event) => {
          // Toggle through React state instead of the native activation: the browser fires
          // toggle asynchronously, so a reload right after closing would otherwise bring the
          // panel back, and React's controlled attribute would double-toggle the native change.
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
