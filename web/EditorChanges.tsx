import { useCallback, useEffect, useRef, useState } from 'react';
import { formatNumber, t, translateMessage, useI18n } from './i18n.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { CloseIcon, EditIcon, ExpandIcon, HistoryIcon } from './ui-icons.js';
import type { ResourceModel } from '../core/resource-editing.js';
import type { ResourceEditorCommands } from './resource-editor.js';
import type { ChangedSection } from './studio-sections.js';

export function EditorChanges<K extends string>({
  commands,
  changes,
  onSelect,
}: {
  commands: ResourceEditorCommands;
  changes: readonly ChangedSection<K>[];
  onSelect: (id: K) => void;
}) {
  useI18n();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const { state } = commands.value;
  const label = t('shared.changeCount', { count: changes.length });
  const discard = () => {
    const title = opener.current
      ?.closest('.editor-studio')
      ?.querySelector<HTMLElement>('.editor-title-field input');
    setOpen(false);
    void commands.discard().then(() => title?.focus());
  };
  return (
    <>
      <button
        ref={opener}
        type="button"
        className="ghost resource-editor-changes"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <EditIcon size={18} aria-hidden="true" />
        <span className="resource-editor-changes-label">{label}</span>
        <span className="resource-editor-changes-count" aria-hidden="true">
          {formatNumber(changes.length)}
        </span>
      </button>
      <Dialog
        open={open && state.dirty}
        title={t('shared.changedSections')}
        className="editor-changes-drawer"
        onClose={() => setOpen(false)}
      >
        <p className="muted">{t('shared.changedSectionsHelp')}</p>
        <ul className="editor-changes-list" aria-label={t('shared.changedSections')}>
          {changes.map((section) => (
            <li key={section.id}>
              <button
                type="button"
                className="editor-changes-item"
                onClick={() => {
                  onSelect(section.id);
                  setOpen(false);
                }}
              >
                <span className="editor-changes-title">{section.title}</span>
                {section.pending && (
                  <span className="editor-changes-badge">{t('shared.pendingInput')}</span>
                )}
                <ExpandIcon size={18} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        <div className="editor-changes-footer">
          <button
            type="button"
            className="secondary"
            disabled={state.saving || !commands.canDiscard}
            onClick={discard}
          >
            <CloseIcon size={18} aria-hidden="true" />
            {t('shared.cancelEditing')}
          </button>
        </div>
      </Dialog>
    </>
  );
}

type PreviousVersion =
  | { status: 'loading' }
  | { status: 'failed'; error: string }
  | { status: 'none' }
  | { status: 'ready'; savedRevision: number; model: ResourceModel };

export function PreviousVersionAction<K extends string>({
  commands,
  compare,
}: {
  commands: ResourceEditorCommands;
  compare: (previous: ResourceModel) => readonly ChangedSection<K>[];
}) {
  useI18n();
  const { session, state } = commands.value;
  const [open, setOpen] = useState(false);
  const [previous, setPrevious] = useState<PreviousVersion>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const revision = state.document.baseRevision ?? 0;
  const load = useCallback(() => {
    const current = ++request.current;
    setError('');
    if (revision <= 1) {
      setPrevious({ status: 'none' });
      return;
    }
    setPrevious({ status: 'loading' });
    session.readPrevious().then(
      (found) => {
        if (request.current === current)
          setPrevious(found ? { status: 'ready', ...found } : { status: 'none' });
      },
      (caught) => {
        if (request.current === current)
          setPrevious({ status: 'failed', error: (caught as Error).message });
      }
    );
  }, [session, revision]);
  useEffect(() => {
    if (!open) return;
    load();
    return () => {
      request.current++;
    };
  }, [open, load]);
  if (!state.document.targetId) return null;
  const stale = previous.status === 'ready' && previous.savedRevision !== revision;
  const sections = previous.status === 'ready' && !stale ? compare(previous.model) : [];
  const close = () => {
    if (!busy) setOpen(false);
  };
  return (
    <div className="action-menu-group">
      <button
        type="button"
        aria-haspopup="dialog"
        disabled={state.saving || state.dirty}
        onClick={() => setOpen(true)}
      >
        <HistoryIcon size={18} aria-hidden="true" />
        {t('shared.comparePrevious')}
      </button>
      <Dialog
        open={open}
        title={t('shared.comparePrevious')}
        className="previous-version-dialog"
        onClose={close}
      >
        {previous.status === 'loading' || previous.status === 'failed' ? (
          <LoadingState
            presentation="inline"
            label={t('shared.loadingPrevious')}
            error={previous.status === 'failed' ? previous.error : ''}
            onRetry={load}
          />
        ) : previous.status === 'none' ? (
          <p>{t('shared.noPreviousVersion')}</p>
        ) : stale ? (
          <p role="alert">{t('shared.previousChanged')}</p>
        ) : sections.length ? (
          <>
            <p>{t('shared.comparePreviousHelp')}</p>
            <ul className="previous-version-sections" aria-label={t('shared.differentSections')}>
              {sections.map((section) => (
                <li key={section.id}>{section.title}</li>
              ))}
            </ul>
          </>
        ) : (
          <p>{t('shared.previousSame')}</p>
        )}
        {error && (
          <p className="error" role="alert">
            {translateMessage(error)}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            {t('shared.cancel')}
          </button>
          {previous.status === 'ready' && (
            <button
              type="button"
              className="primary"
              disabled={busy || stale || !sections.length || state.dirty || state.saving}
              aria-busy={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await commands.restore();
                  setOpen(false);
                } catch (caught) {
                  setError((caught as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('shared.restorePrevious')}
            </button>
          )}
        </div>
      </Dialog>
    </div>
  );
}

export function RestoredVersionNotice({ commands }: { commands: ResourceEditorCommands }) {
  useI18n();
  if (!commands.restored) return null;
  return (
    <NoticeBanner
      className="editor-restored-notice"
      actions={
        <>
          <button
            type="button"
            className="secondary"
            disabled={commands.value.state.saving}
            onClick={() => void commands.undoRestore()}
          >
            {t('shared.undoRestore')}
          </button>
          <IconButton
            className="ghost"
            label={t('shared.close', { title: t('shared.restoredPrevious') })}
            icon={CloseIcon}
            onClick={commands.dismissRestored}
          />
        </>
      }
    >
      <p>{t('shared.restoredPrevious')}</p>
    </NoticeBanner>
  );
}
