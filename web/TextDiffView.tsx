import { Fragment, useMemo, useState } from 'react';
import {
  rewriteAsBlocks,
  type TextDiff,
  type TextDiffHunk,
  type TextDiffSegment,
} from '../core/text-diff.js';
import { formatNumber, t } from './i18n.js';
import {
  hunkGaps,
  hunkStarts,
  proseSides,
  splitRows,
  unifiedLines,
  type DiffCell,
  type DiffGap,
  type LineStart,
  type UnifiedLine,
} from './text-diff-rows.js';
import './text-diff.css';

export type ShownTextDiff = Exclude<TextDiff, { omitted: unknown }>;
export type TextDiffLayout = 'split' | 'unified';

const HUNK_PAGE = 40;

function ProseSegments({ segments }: { segments: readonly TextDiffSegment[] }) {
  return segments.map((segment, index) =>
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
  );
}

export function ProseHunk({ hunk }: { hunk: TextDiffHunk }) {
  return (
    <p className="helper-diff-prose">
      <ProseSegments segments={rewriteAsBlocks(hunk.segments)} />
    </p>
  );
}

function MarkedText({ text, marks }: { text: string; marks: TextDiffSegment[] | null }) {
  if (!marks) return <code>{text}</code>;
  return (
    <code>
      {marks.map((segment, index) =>
        segment.op === 'equal' ? (
          <Fragment key={index}>{segment.text}</Fragment>
        ) : (
          <span key={index} className="text-diff-emphasis">
            {segment.text}
          </span>
        )
      )}
    </code>
  );
}

const sign = (op: string) => (op === 'insert' ? '+' : op === 'delete' ? '−' : '');

function LineLabel({ op }: { op: string }) {
  if (op !== 'insert' && op !== 'delete') return null;
  return (
    <span className="sr-only">
      {t(op === 'insert' ? 'helperChanges.insertedLine' : 'helperChanges.removedLine')}
    </span>
  );
}

const lineNumber = (value: number | null) => (value === null ? '' : formatNumber(value));

function CodeLine({ line, numbered }: { line: UnifiedLine; numbered: boolean }) {
  return (
    <div className="helper-diff-line" data-op={line.op}>
      {numbered && (
        <>
          <span className="text-diff-number" aria-hidden="true">
            {lineNumber(line.before)}
          </span>
          <span className="text-diff-number" aria-hidden="true">
            {lineNumber(line.after)}
          </span>
        </>
      )}
      <span className="helper-diff-gutter" aria-hidden="true">
        {sign(line.op)}
      </span>
      <LineLabel op={line.op} />
      <MarkedText text={line.text} marks={line.marks} />
    </div>
  );
}

function CodeHunk({
  hunk,
  start,
  numbered = false,
}: {
  hunk: TextDiffHunk;
  start?: LineStart;
  numbered?: boolean;
}) {
  return (
    <div className="helper-diff-code" data-numbered={numbered || undefined}>
      {unifiedLines(hunk, start).map((line, index) => (
        <CodeLine key={index} line={line} numbered={numbered} />
      ))}
    </div>
  );
}

function SplitCell({ cell }: { cell: DiffCell | null }) {
  if (!cell) return <div className="helper-diff-line" data-op="empty" aria-hidden="true" />;
  return (
    <div className="helper-diff-line" data-op={cell.op}>
      <span className="text-diff-number" aria-hidden="true">
        {lineNumber(cell.number)}
      </span>
      <span className="helper-diff-gutter" aria-hidden="true">
        {sign(cell.op)}
      </span>
      <LineLabel op={cell.op} />
      <MarkedText text={cell.text} marks={cell.marks} />
    </div>
  );
}

function SplitCodeHunk({ hunk, start }: { hunk: TextDiffHunk; start?: LineStart }) {
  return (
    <div className="helper-diff-code text-diff-split">
      {splitRows(hunk, start).map((row, index) => (
        <div key={index} className="text-diff-split-row">
          <SplitCell cell={row.before} />
          <SplitCell cell={row.after} />
        </div>
      ))}
    </div>
  );
}

function SplitProseHunk({ hunk }: { hunk: TextDiffHunk }) {
  const sides = proseSides(hunk);
  return (
    <div className="text-diff-split text-diff-split-prose">
      <div className="text-diff-split-row">
        <p className="helper-diff-prose" data-side="before">
          <ProseSegments segments={sides.before} />
        </p>
        <p className="helper-diff-prose" data-side="after">
          <ProseSegments segments={sides.after} />
        </p>
      </div>
    </div>
  );
}

export function TextDiffHunks({ diff }: { diff: ShownTextDiff }) {
  return diff.hunks.map((hunk, index) => (
    <div key={`${hunk.beforeOffset}:${hunk.afterOffset}`} className="helper-diff-hunk">
      {index > 0 && (
        <span className="helper-diff-gap" role="separator">
          <span className="sr-only">{t('helperChanges.moreHunks')}</span>
        </span>
      )}
      {diff.mode === 'prose' ? <ProseHunk hunk={hunk} /> : <CodeHunk hunk={hunk} />}
    </div>
  ));
}

function ContextGap({
  gap,
  layout,
  open,
  onOpen,
}: {
  gap: DiffGap | undefined;
  layout: TextDiffLayout;
  open: boolean;
  onOpen: () => void;
}) {
  if (!gap?.lines.length) return null;
  if (!open)
    return (
      <div className="text-diff-context">
        <button type="button" className="ghost" onClick={onOpen}>
          {t('shared.showHiddenLines', { count: gap.lines.length })}
        </button>
      </div>
    );
  const hunk: TextDiffHunk = {
    beforeOffset: 0,
    afterOffset: 0,
    segments: [{ op: 'equal', text: `${gap.lines.join('\n')}\n` }],
  };
  const start = { before: gap.before, after: gap.after };
  return layout === 'split' ? (
    <SplitCodeHunk hunk={hunk} start={start} />
  ) : (
    <CodeHunk hunk={hunk} start={start} numbered />
  );
}

export function TextDiffDocument({
  diff,
  before,
  after,
  layout,
}: {
  diff: ShownTextDiff;
  before: string;
  after: string;
  layout: TextDiffLayout;
}) {
  const [limit, setLimit] = useState(HUNK_PAGE);
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
  const code = diff.mode === 'code';
  const starts = useMemo(
    () => (code ? hunkStarts(diff.hunks, before, after) : []),
    [code, diff, before, after]
  );
  const gaps = useMemo(
    () => (code ? hunkGaps(diff.hunks, before, after) : []),
    [code, diff, before, after]
  );
  const shown = diff.hunks.slice(0, limit);
  const gap = (index: number) => (
    <ContextGap
      gap={gaps[index]}
      layout={layout}
      open={opened.has(index)}
      onOpen={() => setOpened((current) => new Set(current).add(index))}
    />
  );
  return (
    <div className="text-diff-document" data-layout={layout} data-mode={diff.mode}>
      {shown.map((hunk, index) => (
        <Fragment key={`${hunk.beforeOffset}:${hunk.afterOffset}`}>
          {code
            ? gap(index)
            : index > 0 && (
                <span className="helper-diff-gap" role="separator">
                  <span className="sr-only">{t('helperChanges.moreHunks')}</span>
                </span>
              )}
          {code ? (
            layout === 'split' ? (
              <SplitCodeHunk hunk={hunk} start={starts[index]} />
            ) : (
              <CodeHunk hunk={hunk} start={starts[index]} numbered />
            )
          ) : layout === 'split' ? (
            <SplitProseHunk hunk={hunk} />
          ) : (
            <ProseHunk hunk={hunk} />
          )}
        </Fragment>
      ))}
      {code && shown.length === diff.hunks.length && gap(diff.hunks.length)}
      {diff.hunks.length > limit && (
        <button
          type="button"
          className="secondary text-diff-more"
          onClick={() => setLimit((current) => current + HUNK_PAGE)}
        >
          {t('shared.showMoreHunks', { count: diff.hunks.length - limit })}
        </button>
      )}
    </div>
  );
}

export function TextDiffStats({ diff }: { diff: ShownTextDiff }) {
  if (diff.added <= 0 && diff.removed <= 0) return null;
  return (
    <span className="helper-change-stats">
      <span aria-hidden="true">
        {diff.added > 0 && <span className="helper-change-added">+{formatNumber(diff.added)}</span>}
        {diff.removed > 0 && (
          <span className="helper-change-removed">−{formatNumber(diff.removed)}</span>
        )}
      </span>
      <span className="sr-only">
        {t(diff.unit === 'word' ? 'helperChanges.wordStats' : 'helperChanges.lineStats', {
          added: diff.added,
          removed: diff.removed,
        })}
      </span>
    </span>
  );
}

export const textDiffOmission = (diff: TextDiff) =>
  'omitted' in diff
    ? t(diff.omitted === 'size' ? 'helperChanges.omittedSize' : 'helperChanges.omittedTime')
    : '';
