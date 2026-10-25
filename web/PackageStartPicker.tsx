import { t, useI18n, translateMessage, message as uiMessage, messageRef } from './i18n.js';
import { useEffect, useRef, useState } from 'react';
import { ListRestart } from 'lucide-react';
import type { Content } from '../core/product.js';
import type { PackageStartRef } from '../core/package-start.js';
import type { Run, Source } from '../core/types.js';
import { api, definiteRejection } from './api.js';
import { Dialog } from './Dialog.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { RisuStartPreview } from './RisuStartPreview.js';
import { SaveButton } from './SaveButton.js';
import './package-start-picker.css';

export type PackageStartSelection = PackageStartRef & {
  expectedSettingsRevision: number;
  expectedProfileRevision: number;
  userName?: string;
};
type Command = Omit<PackageStartSelection, 'userName' | 'startId'> & {
  startId: string | null;
  expectedRevision: string;
  expectedSourceHash: string;
  idempotencyKey: string;
};

export function PackageStartPicker({
  open,
  onClose,
  source,
  selection,
  disabled,
  refresh,
  onError,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  source: Source;
  selection: PackageStartSelection;
  disabled?: boolean;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
  onChanged?: () => void;
}) {
  useI18n();
  const [content, setContent] = useState<Content | null>(null);
  const [readError, setReadError] = useState('');
  const [readAttempt, setReadAttempt] = useState(0);
  const [selected, setSelected] = useState(selection.startId);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const submitted = useRef<Command | null>(null);
  const submitting = useRef(false);
  const reviewed = useRef({ source, selection });
  // biome-ignore lint/correctness/useExhaustiveDependencies: Opening captures the reviewed revisions; live updates must not silently adopt a newer write target.
  useEffect(() => {
    if (open && !submitted.current) {
      reviewed.current = { source, selection };
      setSelected(selection.startId);
      setExpanded(false);
      setError('');
    }
  }, [open]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit failed-read retry repeats the same pinned selection.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setReadError('');
    void api<Content>(
      '/revisions/content/' +
        encodeURIComponent(selection.packageId) +
        '/' +
        selection.packageRevision,
      undefined,
      'GET',
      controller.signal
    ).then(
      (value) => {
        if (!controller.signal.aborted) setContent(value);
      },
      (cause: Error) => {
        if (!controller.signal.aborted) setReadError(cause.message);
      }
    );
    return () => controller.abort();
  }, [open, selection.packageId, selection.packageRevision, readAttempt]);
  const starts = content?.package?.starts ?? [];
  async function apply() {
    if (submitting.current || disabled) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    const captured = reviewed.current;
    const command = (submitted.current ??= {
      packageId: captured.selection.packageId,
      packageRevision: captured.selection.packageRevision,
      startId: selected || null,
      expectedSettingsRevision: captured.selection.expectedSettingsRevision,
      expectedProfileRevision: captured.selection.expectedProfileRevision,
      expectedRevision: captured.source.id,
      expectedSourceHash: captured.source.hash,
      idempotencyKey: crypto.randomUUID(),
    });
    try {
      const result = await api<{ run: Run | null }>(
        '/chats/' + source.chatId + '/package-start',
        command
      );
      submitted.current = null;
      if (!mounted.current) return;
      setUncertain(false);
      onChanged?.();
      onClose();
      try {
        await refresh();
        // The old trigger disappears. An empty reader returns focus to the retained draft.
        requestAnimationFrame(() => {
          const target = result.run
            ? document
                .getElementById('source-' + result.run.sourceRevision)
                ?.querySelector<HTMLElement>('.action-menu > summary')
            : document.querySelector<HTMLElement>('[data-uimori-part="composer-input"]');
          target?.focus({ preventScroll: true });
        });
      } catch (cause) {
        onError(
          uiMessage('library.openingRefreshError', { error: messageRef((cause as Error).message) })
        );
      }
    } catch (cause) {
      if (!mounted.current) return;
      if (definiteRejection(cause)) {
        submitted.current = null;
        setUncertain(false);
        setError((cause as Error).message);
      } else {
        setUncertain(true);
        setError(uiMessage('library.couldNotConfirmTheResultCheckThe'));
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!submitting.current) onClose();
      }}
      title={t('library.changeOpening')}
    >
      {!content || readError ? (
        <LoadingState
          label={t('library.loadingOpenings')}
          error={readError}
          errorLabel={t('library.couldNotLoadOpenings')}
          onRetry={() => setReadAttempt((value) => value + 1)}
        />
      ) : (
        <>
          <label>
            {t('library.chooseFirstMessage')}
            <select
              value={selected}
              disabled={busy || uncertain || disabled}
              onChange={(event) => {
                setSelected(event.target.value);
                setExpanded(false);
                setError('');
              }}
            >
              <option value="">{t('transfer.m342')}</option>
              {starts.map((start) => (
                <option key={start.id} value={start.id}>
                  {start.title}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <details
              key={selected}
              className="package-start-preview"
              onToggle={(event) => setExpanded(event.currentTarget.open)}
            >
              <summary>{t('library.preview')}</summary>
              {expanded && (
                <div
                  className="package-start-preview-body"
                  aria-label={t('library.fullFirstMessagePreview')}
                >
                  <RisuStartPreview
                    content={content}
                    startId={selected}
                    userName={selection.userName}
                  />
                </div>
              )}
            </details>
          )}
          <p className="muted">{t('library.changesThisChatSFirstMessageYour')}</p>
        </>
      )}
      {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
      <div className="form-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>
          {t('library.cancel')}
        </button>
        <SaveButton
          type="button"
          label={uncertain ? t('library.checkOpeningChangeResult') : t('library.changeOpening')}
          text={uncertain ? t('library.checkResult') : t('library.change')}
          icon={ListRestart}
          aria-busy={busy}
          disabled={
            disabled ||
            (!uncertain &&
              (!content ||
                !!readError ||
                selected === selection.startId ||
                (selected !== '' && !starts.some((start) => start.id === selected))))
          }
          onClick={() => void apply()}
        />
      </div>
    </Dialog>
  );
}
