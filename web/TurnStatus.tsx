import { t, useI18n } from './i18n.js';
import { useState, type ReactNode } from 'react';
import {
  DoneIcon,
  DropdownIcon,
  IssueIcon,
  RunningIcon,
  StopIcon,
  UncertainIcon,
} from './ui-icons.js';
import './turn-activity.css';
import './activity-status.css';
import { readOptionalStorage, writeOptionalStorage } from './optional-storage.js';

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
  const [open, setOpen] = useState(
    () => !!storageKey && readOptionalStorage('session', storageKey) === 'open'
  );
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
      <DropdownIcon size={14} aria-hidden="true" className="turn-activity-chevron" />
    </span>
  );
  const persist = (next: boolean) => {
    setOpen(next);
    if (next) setVisited(true);
    onOpenChange?.(next);
    if (storageKey) writeOptionalStorage('session', storageKey, next ? 'open' : 'closed');
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
          // https://html.spec.whatwg.org/multipage/interactive-elements.html#queue-a-details-toggle-event-task (2026-11-20):
          // a change to the details open attribute fires toggle later, from a queued element task.
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
