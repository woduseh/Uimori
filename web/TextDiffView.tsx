import type { TextDiff, TextDiffHunk } from '../core/text-diff.js';
import { formatNumber, t } from './i18n.js';
import './text-diff.css';

export type ShownTextDiff = Exclude<TextDiff, { omitted: unknown }>;

export function ProseHunk({ hunk }: { hunk: TextDiffHunk }) {
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

function lines(text: string) {
  const parts = text.split('\n');
  if (parts.at(-1) === '') parts.pop();
  return parts;
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
