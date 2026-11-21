import { useId, useRef, useState, type ReactNode } from 'react';
import {
  BookMarked,
  BookOpen,
  ChevronDown,
  FileText,
  Heading,
  Image,
  Languages,
  ListTree,
  Palette,
  PenLine,
  Settings2,
  SquareArrowOutUpRight,
  StickyNote,
} from 'lucide-react';
import type { HelperChange } from '../core/helper.js';
import type { TextDiffHunk } from '../core/text-diff.js';
import { helperChangeLocationParts } from './helper-change-location.js';
import { formatNumber, t } from './i18n.js';
import { IconButton } from './IconButton.js';
import { NoticeBanner } from './NoticeBanner.js';

const resourceIcons = {
  content: BookOpen,
  'prompt-preset': FileText,
  'prompt-workspace': FileText,
  theme: Palette,
  'illustration-preset': Image,
};

function changeIcon(change: HelperChange) {
  if (change.domain === 'resource')
    return change.anchor?.domain === 'resource' ? resourceIcons[change.anchor.kind] : BookOpen;
  if (change.domain === 'scene')
    return change.targetId.endsWith(':translation')
      ? Languages
      : change.targetId.endsWith(':title')
        ? Heading
        : PenLine;
  if (change.domain === 'outline') return ListTree;
  if (change.domain === 'notes') return StickyNote;
  if (change.domain === 'chat-lore') return BookMarked;
  return Settings2;
}

const actionLabels: Partial<Record<HelperChange['action'], string>> = {
  create: 'helperChanges.created',
  delete: 'helperResults.deleted',
  reorder: 'helperChanges.reordered',
};

function lines(text: string) {
  const parts = text.split('\n');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

function ProseHunk({ hunk }: { hunk: TextDiffHunk }) {
  return (
    <p className="helper-diff-prose">
      {hunk.segments.map((segment, index) =>
        segment.op === 'equal' ? (
          <span key={index}>{segment.text}</span>
        ) : segment.op === 'insert' ? (
          <ins key={index}>
            <span className="sr-only">{t('helperChanges.inserted')} </span>
            {segment.text}
          </ins>
        ) : (
          <del key={index}>
            <span className="sr-only">{t('helperChanges.removed')} </span>
            {segment.text}
          </del>
        )
      )}
    </p>
  );
}

function CodeHunk({ hunk }: { hunk: TextDiffHunk }) {
  return (
    <div className="helper-diff-code">
      {hunk.segments.flatMap((segment, index) =>
        lines(segment.text).map((line, row) => (
          <div key={`${index}:${row}`} className="helper-diff-line" data-op={segment.op}>
            <span className="helper-diff-gutter" aria-hidden="true">
              {segment.op === 'insert' ? '+' : segment.op === 'delete' ? '−' : ''}
            </span>
            {segment.op !== 'equal' && (
              <span className="sr-only">
                {t(
                  segment.op === 'insert'
                    ? 'helperChanges.insertedLine'
                    : 'helperChanges.removedLine'
                )}
              </span>
            )}
            <code>{line}</code>
          </div>
        ))
      )}
    </div>
  );
}

export function HelperChangeCard({
  change,
  onOpen,
  rollback,
  outcome,
}: {
  change: HelperChange;
  onOpen?: (change: HelperChange) => Promise<void> | void;
  rollback?: ReactNode;
  outcome?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);
  const regionId = useId();
  const Icon = changeIcon(change);
  const diff = change.diff;
  const hunks = diff && !('omitted' in diff) && diff.hunks.length ? diff : null;
  const note = change.textRemoved
    ? t(
        change.textRemoved === 'deleted' ? 'helperChanges.textDeleted' : 'helperChanges.textExpired'
      )
    : diff && 'omitted' in diff
      ? t(diff.omitted === 'size' ? 'helperChanges.omittedSize' : 'helperChanges.omittedTime')
      : '';
  const action = actionLabels[change.action];
  const location = change.location ? helperChangeLocationParts(change.location) : [];
  const name = [change.title, ...location.map((part) => part.text)].join(', ');
  const openable = !!onOpen && !!change.anchor && !change.textRemoved;
  async function open() {
    if (!onOpen || pending.current) return;
    pending.current = true;
    setOpening(true);
    setFailed(false);
    try {
      await onOpen(change);
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setOpening(false);
    }
  }
  const identity = (
    <>
      <Icon size={16} aria-hidden="true" />
      <span className="helper-result-identity">
        <span>{change.title}</span>
        {location.length > 0 && (
          <small className="helper-change-location">
            {location.map((part, index) =>
              part.identifier ? (
                <code key={index}>{part.text}</code>
              ) : (
                <span key={index}>{part.text}</span>
              )
            )}
          </small>
        )}
      </span>
      {hunks && (hunks.added > 0 || hunks.removed > 0) && (
        <span className="helper-change-stats">
          <span aria-hidden="true">
            {hunks.added > 0 && (
              <span className="helper-change-added">+{formatNumber(hunks.added)}</span>
            )}
            {hunks.removed > 0 && (
              <span className="helper-change-removed">−{formatNumber(hunks.removed)}</span>
            )}
          </span>
          <span className="sr-only">
            {t(hunks.unit === 'word' ? 'helperChanges.wordStats' : 'helperChanges.lineStats', {
              added: hunks.added,
              removed: hunks.removed,
            })}
          </span>
        </span>
      )}
      {action && <span className="helper-change-action">{t(action)}</span>}
    </>
  );
  return (
    <div className="helper-change" data-domain={change.domain} data-expanded={expanded}>
      <div className="helper-change-head">
        {hunks ? (
          <button
            type="button"
            className="helper-result-target helper-change-toggle"
            aria-expanded={expanded}
            aria-controls={regionId}
            onClick={() => setExpanded((value) => !value)}
          >
            {identity}
            <ChevronDown size={16} aria-hidden="true" className="helper-change-chevron" />
          </button>
        ) : (
          <div className="helper-result-target">{identity}</div>
        )}
        {openable && (
          <IconButton
            className="helper-change-open"
            icon={SquareArrowOutUpRight}
            size={16}
            label={t('helperResults.openTarget', { title: name })}
            disabled={opening}
            aria-busy={opening}
            onClick={() => void open()}
          />
        )}
        {rollback}
      </div>
      {note && <p className="helper-result-note helper-change-note">{note}</p>}
      {outcome}
      {hunks && (
        <div
          id={regionId}
          className="helper-change-diff"
          role="region"
          aria-label={t('helperChanges.diffRegion', { title: name })}
          tabIndex={0}
          hidden={!expanded}
          data-mode={hunks.mode}
        >
          {expanded &&
            hunks.hunks.map((hunk, index) => (
              <div key={`${hunk.beforeOffset}:${hunk.afterOffset}`} className="helper-diff-hunk">
                {index > 0 && (
                  <span className="helper-diff-gap" role="separator">
                    <span className="sr-only">{t('helperChanges.moreHunks')}</span>
                  </span>
                )}
                {hunks.mode === 'prose' ? <ProseHunk hunk={hunk} /> : <CodeHunk hunk={hunk} />}
              </div>
            ))}
        </div>
      )}
      {failed && <NoticeBanner tone="error">{t('helperResults.openFailed')}</NoticeBanner>}
    </div>
  );
}
