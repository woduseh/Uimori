import { useEffect, useRef, useState } from 'react';
import type { HelperContextSummaryView } from '../core/helper.js';
import { api, ApiError } from './api.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { Dialog } from './Dialog.js';
import { formatNumber, t, translateMessage, useI18n, message as legacyDescriptor } from './i18n.js';
import { uiMessage, legacyUiMessage } from './ui-message.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { SummaryEditor } from './SummaryEditor.js';
import './helper-summary.css';

export type HelperSummaryDraft = { text: string; revision: number };

const failure = (caught: unknown) =>
  caught instanceof Error ? caught.message : legacyDescriptor('helperSummary.loadFailed');

export function HelperSummaryDialog({
  open,
  conversationId,
  checkpointRevision,
  busy,
  draft,
  onDraftChange,
  onChanged,
  onClose,
}: {
  open: boolean;
  conversationId: string;
  checkpointRevision: number | undefined;
  busy: boolean;
  draft: HelperSummaryDraft | null;
  onDraftChange: (draft: HelperSummaryDraft | null) => void;
  onChanged: (message: string) => Promise<void>;
  onClose: () => void;
}) {
  useI18n();
  const [current, setCurrent] = useState<HelperContextSummaryView | null>(null);
  const [error, setError] = useState('');
  const [readFailed, setReadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const sequence = useRef(0);
  const editorInput = useRef<HTMLTextAreaElement>(null);
  const editTrigger = useRef<HTMLButtonElement>(null);
  const focus = useRef<'editor' | 'trigger' | null>(null);
  const base = `/helper/conversations/${encodeURIComponent(conversationId)}/context`;

  function show(view: HelperContextSummaryView) {
    sequence.current++;
    setCurrent(view);
    setReadFailed(false);
  }
  async function load() {
    const request = ++sequence.current;
    try {
      const view = await api<HelperContextSummaryView>(base);
      if (request !== sequence.current) return null;
      setCurrent(view);
      setReadFailed(false);
      return view;
    } catch (caught) {
      if (request === sequence.current) {
        setReadFailed(true);
        setError(failure(caught));
      }
      return null;
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new summary revision refreshes the read without depending on render-local callbacks.
  useEffect(() => {
    if (open) void load();
  }, [open, checkpointRevision]);
  const editing = draft !== null;
  useEffect(() => {
    if (focus.current === 'editor' && editing) editorInput.current?.focus();
    if (focus.current === 'trigger' && !editing) editTrigger.current?.focus();
    focus.current = null;
  }, [editing]);

  const blocked = busy || saving || !current?.editable;
  const resetBlocked = busy || saving || current?.blockedReason === 'HELPER_COMPACTION_BUSY';
  const conflict = Boolean(
    draft && current && (draft.revision !== current.checkpointRevision || current.summary === null)
  );

  async function save() {
    if (!draft || saving || conflict || blocked || !draft.text.trim()) return;
    setSaving(true);
    setError('');
    try {
      show(
        await api<HelperContextSummaryView>(
          `${base}/summary`,
          { expectedRevision: draft.revision, summary: draft.text },
          'PUT'
        )
      );
      focus.current = 'trigger';
      onDraftChange(null);
      await onChanged(legacyDescriptor('helperSummary.saved'));
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        const latest = await load();
        if (latest?.summary === draft.text) {
          focus.current = 'trigger';
          onDraftChange(null);
          await onChanged(legacyDescriptor('helperSummary.saved'));
          return;
        }
      }
      setError(failure(caught));
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    if (!current || saving) return;
    setSaving(true);
    setError('');
    try {
      show(
        await api<HelperContextSummaryView>(
          `${base}/summary`,
          { expectedRevision: current.checkpointRevision },
          'DELETE'
        )
      );
      setConfirmReset(false);
      await onChanged(legacyDescriptor('helperSummary.resetDone'));
    } catch (caught) {
      setConfirmReset(false);
      setError(failure(caught));
      if (caught instanceof ApiError && caught.status === 409) await load();
    } finally {
      setSaving(false);
    }
  }

  const origin = current?.origin;
  const latest = current?.summary ? (
    <div className="helper-summary-current">
      <ul className="helper-summary-meta" aria-label={t('helperSummary.details')}>
        {origin && <li>{t(`helperSummary.origin.${origin}`)}</li>}
        <li>{t('helperSummary.covered', { count: current.compactedMessages })}</li>
        <li>{t('helperSummary.chars', { count: current.summary.length })}</li>
        {current.summaryTokens !== null && (
          <li>
            {current.budgetTokens === null
              ? t('helperSummary.tokens', { tokens: formatNumber(current.summaryTokens) })
              : t('helperSummary.tokensOfLimit', {
                  tokens: formatNumber(current.summaryTokens),
                  limit: formatNumber(current.budgetTokens),
                })}
          </li>
        )}
      </ul>
      <p className="context-text" data-testid="helper-summary-text">
        {current.summary}
      </p>
    </div>
  ) : null;

  return (
    <Dialog
      open={open}
      title={t('helperSummary.title')}
      className="helper-summary-dialog"
      scopeKey={conversationId}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <div className="helper-summary">
        {current && error && (
          <NoticeBanner
            tone="error"
            actions={
              readFailed ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setError('');
                    void load();
                  }}
                >
                  {t('shared.retry')}
                </button>
              ) : undefined
            }
          >
            {translateMessage(error)}
          </NoticeBanner>
        )}
        {!current ? (
          <LoadingState
            presentation="placeholder"
            loading={!error}
            error={legacyUiMessage(error)}
            label={uiMessage('helperSummary.loading')}
            onRetry={() => {
              setError('');
              void load();
            }}
          />
        ) : (
          <>
            {draft && !conflict
              ? null
              : (latest ?? <p className="muted">{t('helperSummary.empty')}</p>)}
            {draft && (
              <SummaryEditor
                value={draft.text}
                saved={current.summary ?? ''}
                busy={saving}
                conflict={conflict}
                conflictMessage={t('helperSummary.conflict')}
                saveDisabled={blocked || conflict || !draft.text.trim()}
                rebaseDisabled={saving || current.summary === null}
                inputRef={editorInput}
                onChange={(text) => onDraftChange({ ...draft, text })}
                onRebase={() => {
                  onDraftChange({ ...draft, revision: current.checkpointRevision });
                  setError('');
                }}
                onCancel={() => {
                  focus.current = 'trigger';
                  onDraftChange(null);
                  setError('');
                }}
                onSave={() => void save()}
              />
            )}
            {!draft && current.summary !== null && (
              <div className="form-actions">
                <button
                  ref={editTrigger}
                  type="button"
                  className="secondary"
                  disabled={blocked}
                  onClick={() => {
                    focus.current = 'editor';
                    setError('');
                    onDraftChange({
                      text: current.summary ?? '',
                      revision: current.checkpointRevision,
                    });
                  }}
                >
                  {t('helperSummary.edit')}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={resetBlocked}
                  onClick={() => setConfirmReset(true)}
                >
                  {t('helperSummary.reset')}
                </button>
              </div>
            )}
            {current.summary !== null &&
              (busy || current.blockedReason === 'HELPER_COMPACTION_BUSY' ? (
                <p className="muted">{t('helperSummary.busyHint')}</p>
              ) : current.blockedReason === 'MODEL_REQUIRED:helper' ? (
                <p className="muted">{t('helperSummary.modelRequired')}</p>
              ) : null)}
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirmReset}
        title={t('helperSummary.resetTitle')}
        body={t('helperSummary.resetMessage')}
        action={t('helperSummary.resetAction')}
        busy={saving}
        disabled={resetBlocked}
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => void reset()}
      />
    </Dialog>
  );
}
