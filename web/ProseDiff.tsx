import type { TextDiffHunk } from '../core/text-diff.js';
import { t } from './i18n.js';
import './prose-diff.css';

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
