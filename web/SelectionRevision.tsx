import { t, useI18n, translateMessage } from './i18n.js';
import { useLayoutEffect, useRef, useState } from 'react';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { validRevisionRange } from '../core/selection-revision.js';
import { useSelectionRevision } from './useSelectionRevision.js';
import { CodexContentWarningDialog } from './CodexContentWarningDialog.js';
import { IconButton } from './IconButton.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { CheckIcon, CloseIcon, EditIcon, RefreshIcon, StopIcon } from './ui-icons.js';

type Selection = { start: number; end: number; version: number };
type Props = {
  sourceId: string;
  chatId: string;
  text: string;
  draftVersion: number;
  selection: Selection;
  expectedSourceHash: string;
  expectedRevision: number;
  disabled: boolean;
  onApply: (text: string, start: number, end: number) => void;
};

export function SelectionRevision(props: Props) {
  useI18n();
  const revision = useSelectionRevision({
    chatId: props.chatId,
    sourceId: props.sourceId,
    identity: props.disabled
      ? null
      : `${props.draftVersion}:${props.selection.version}:${props.expectedRevision}:${props.expectedSourceHash}`,
  });
  const { captured, proposal, busy, stale } = revision;
  const [instruction, setInstruction] = useState('');
  const opener = useRef<HTMLButtonElement>(null);
  const focusOpener = useRef(false);
  useLayoutEffect(() => {
    if (captured || !focusOpener.current) return;
    focusOpener.current = false;
    opener.current?.focus({ preventScroll: true });
  }, [captured]);
  return (
    <section
      className="selection-revision"
      aria-label={t('reader.reviseSelectedPassage')}
      onKeyDown={(event) => {
        if (!captured || event.key !== 'Escape') return;
        if (event.target instanceof Element && event.target.closest('dialog')) return;
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        event.stopPropagation();
        focusOpener.current = true;
        revision.close();
      }}
    >
      {!captured ? (
        <button
          ref={opener}
          type="button"
          className="secondary"
          disabled={
            props.disabled ||
            !validRevisionRange(props.text, props.selection.start, props.selection.end)
          }
          onClick={() =>
            revision.open({
              draft: props.text,
              start: props.selection.start,
              end: props.selection.end,
              expectedSourceHash: props.expectedSourceHash,
              expectedRevision: props.expectedRevision,
            })
          }
        >
          <EditIcon size={18} aria-hidden="true" />
          {t('reader.reviseSelectedPassage2')}
        </button>
      ) : (
        <>
          <div className="selection-revision-heading">
            <strong>{t('reader.reviseSelectedPassage')}</strong>
            <IconButton
              label={t('reader.closeRevision')}
              icon={CloseIcon}
              onClick={revision.close}
            />
          </div>
          <div className="selection-revision-comparison">
            <div>
              <strong>{t('reader.selectedOriginal')}</strong>
              <pre>{captured.draft.slice(captured.start, captured.end)}</pre>
            </div>
            {proposal !== null && (
              <div>
                <strong>{t('reader.revisionSuggestion')}</strong>
                <pre data-testid="selection-revision-proposal">{proposal}</pre>
              </div>
            )}
          </div>
          <label>
            {t('reader.revisionRequest')}
            <textarea
              rows={3}
              maxLength={REQUEST_TEXT_MAX_CHARS}
              value={instruction}
              disabled={busy}
              placeholder={t('reader.keepTheMeaningButReduceSentencesThatDirectlyExplain')}
              onChange={(event) => {
                setInstruction(event.target.value);
                revision.clearProposal();
              }}
            />
          </label>
          {stale && (
            <NoticeBanner>
              {t('reader.theDraftOrSelectionChangedYourInputIsPreserved')}
            </NoticeBanner>
          )}
          {revision.error && (
            <NoticeBanner tone="error">{translateMessage(revision.error)}</NoticeBanner>
          )}
          {busy && (
            <LoadingState presentation="inline" label={t('reader.refiningTheSelectedPassage')} />
          )}
          <div className="form-actions">
            {busy ? (
              <button type="button" className="secondary" onClick={revision.cancel}>
                <StopIcon size={18} aria-hidden="true" />
                {t('reader.cancelRevisionRequest')}
              </button>
            ) : proposal !== null ? (
              <IconButton
                label={t('reader.getAnotherSuggestion')}
                icon={RefreshIcon}
                disabled={stale || !instruction.trim()}
                onClick={() => void revision.requestProposal(instruction)}
              />
            ) : (
              <button
                type="button"
                className="primary"
                aria-label={t('reader.getRevisionSuggestion')}
                disabled={stale || !instruction.trim()}
                onClick={() => void revision.requestProposal(instruction)}
              >
                <EditIcon size={18} aria-hidden="true" />
                {t('reader.getSuggestion')}
              </button>
            )}
            {proposal !== null && (
              <button
                type="button"
                className="primary"
                disabled={busy || stale}
                onClick={() => {
                  if (!revision.isCurrent()) return;
                  const { draft, start, end } = captured;
                  props.onApply(
                    draft.slice(0, start) + proposal + draft.slice(end),
                    start,
                    start + proposal.length
                  );
                  revision.close();
                }}
              >
                <CheckIcon size={18} aria-hidden="true" />
                {t('reader.applyToDraft')}
              </button>
            )}
          </div>
          <CodexContentWarningDialog gate={revision.codexWarning} />
        </>
      )}
    </section>
  );
}
