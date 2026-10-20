import { t, useI18n, translateMessage, message as uiMessage } from './i18n.js';
import { useLayoutEffect, useRef, useState } from 'react';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { validRevisionRange, type SelectionRevisionResult } from '../core/selection-revision.js';
import { api } from './api.js';
import { useCodexContentWarning } from './useCodexContentWarning.js';
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
type Captured = Pick<
  Props,
  'text' | 'draftVersion' | 'selection' | 'expectedSourceHash' | 'expectedRevision'
>;

export function SelectionRevision(props: Props) {
  useI18n();
  const current = useRef(props);
  current.current = props;
  const [captured, setCaptured] = useState<Captured | null>(null);
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const codexWarning = useCodexContentWarning();
  useLayoutEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    []
  );

  function matches(value: Captured) {
    const latest = current.current;
    return (
      !latest.disabled &&
      latest.text === value.text &&
      latest.draftVersion === value.draftVersion &&
      latest.selection.version === value.selection.version &&
      latest.expectedRevision === value.expectedRevision &&
      latest.expectedSourceHash === value.expectedSourceHash
    );
  }
  const stale = captured !== null && !matches(captured);
  function cancel() {
    pending.current?.abort();
    pending.current = null;
    codexWarning.cancelRequest();
    setBusy(false);
  }
  function close() {
    cancel();
    setCaptured(null);
    setProposal(null);
    setError('');
  }
  async function requestProposal() {
    if (!captured || !matches(captured) || pending.current || !instruction.trim()) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setProposal(null);
    try {
      const proceed = await codexWarning.check(
        `/chats/${encodeURIComponent(props.chatId)}/codex-content-preflight`,
        {
          role: 'selection-revision',
          text: instruction,
          selection: captured.text.slice(captured.selection.start, captured.selection.end),
        },
        'selection-revision',
        controller.signal
      );
      if (
        !proceed ||
        pending.current !== controller ||
        controller.signal.aborted ||
        !matches(captured)
      )
        return;
      const result = await api<SelectionRevisionResult>(
        `/sources/${encodeURIComponent(props.sourceId)}/selection-revision`,
        {
          draft: captured.text,
          start: captured.selection.start,
          end: captured.selection.end,
          instruction,
          expectedSourceHash: captured.expectedSourceHash,
          expectedRevision: captured.expectedRevision,
        },
        'POST',
        controller.signal
      );
      if (pending.current === controller && !controller.signal.aborted) setProposal(result.text);
    } catch (cause) {
      if (pending.current === controller && !controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : uiMessage('reader.couldNotGetARevisionSuggestion')
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <section className="selection-revision" aria-label={t('reader.reviseSelectedPassage')}>
      {!captured ? (
        <>
          <button
            type="button"
            className="secondary"
            disabled={
              props.disabled ||
              !validRevisionRange(props.text, props.selection.start, props.selection.end)
            }
            onClick={() => {
              setCaptured({
                text: props.text,
                draftVersion: props.draftVersion,
                selection: props.selection,
                expectedSourceHash: props.expectedSourceHash,
                expectedRevision: props.expectedRevision,
              });
              setProposal(null);
              setError('');
            }}
          >
            <EditIcon size={18} aria-hidden="true" />
            {t('reader.reviseSelectedPassage2')}
          </button>
          <p className="muted">{t('reader.selectAPassageInTheOriginalToAskThe')}</p>
        </>
      ) : (
        <>
          <div className="selection-revision-heading">
            <strong>{t('reader.reviseSelectedPassage')}</strong>
            <IconButton label={t('reader.closeRevision')} icon={CloseIcon} onClick={close} />
          </div>
          <div className="selection-revision-comparison">
            <div>
              <strong>{t('reader.selectedOriginal')}</strong>
              <pre>{captured.text.slice(captured.selection.start, captured.selection.end)}</pre>
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
                setProposal(null);
              }}
            />
          </label>
          <p className="muted">{t('reader.callsTheHelperModelOnceChargesMayApplyDepending')}</p>
          {stale && (
            <NoticeBanner>
              {t('reader.theDraftOrSelectionChangedYourInputIsPreserved')}
            </NoticeBanner>
          )}
          {error && (
            <NoticeBanner tone="error">
              {t('reader.errorEditsPreserved', { error: translateMessage(error) })}
            </NoticeBanner>
          )}
          {busy && (
            <LoadingState presentation="inline" label={t('reader.refiningTheSelectedPassage')} />
          )}
          <div className="form-actions">
            {busy ? (
              <button type="button" className="secondary" onClick={cancel}>
                <StopIcon size={18} aria-hidden="true" />
                {t('reader.cancelRevisionRequest')}
              </button>
            ) : proposal !== null ? (
              <IconButton
                label={t('reader.getAnotherSuggestion')}
                icon={RefreshIcon}
                disabled={stale || !instruction.trim()}
                onClick={() => void requestProposal()}
              />
            ) : (
              <button
                type="button"
                className="primary"
                aria-label={t('reader.getRevisionSuggestion')}
                disabled={stale || !instruction.trim()}
                onClick={() => void requestProposal()}
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
                  if (!matches(captured)) return;
                  const { start, end } = captured.selection;
                  props.onApply(
                    captured.text.slice(0, start) + proposal + captured.text.slice(end),
                    start,
                    start + proposal.length
                  );
                  close();
                }}
              >
                <CheckIcon size={18} aria-hidden="true" />
                {t('reader.applyToDraft')}
              </button>
            )}
          </div>
          <CodexContentWarningDialog gate={codexWarning} />
        </>
      )}
    </section>
  );
}
