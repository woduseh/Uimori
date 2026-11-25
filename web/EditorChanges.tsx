import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatNumber, t, translateMessage, useI18n } from './i18n.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { CloseIcon, EditIcon, HistoryIcon } from './ui-icons.js';
import { ChangedSectionList } from './EditorFieldChanges.js';
import { changedValuePaths } from './editor-values.js';
import type { ResourceModel } from '../core/resource-editing.js';
import type { ResourceEditorCommands } from './resource-editor.js';
import type { ChangedSection } from './studio-sections.js';

export function EditorChanges<K extends string>({
  commands,
  changes,
  current,
  sectionOf,
  onSelect,
}: {
  commands: ResourceEditorCommands;
  changes: readonly ChangedSection<K>[];
  current: ResourceModel;
  sectionOf: (path: string) => K;
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
        <ChangedSectionList
          label={t('shared.changedSections')}
          sections={changes}
          before={state.document.baseModel}
          after={current}
          sectionOf={sectionOf}
          onSelect={(id) => {
            onSelect(id);
            setOpen(false);
          }}
        />
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

const sameModel = (model: ResourceModel) => model;

type PreviousVersion =
  | { status: 'loading' }
  | { status: 'failed'; error: string }
  | { status: 'none' }
  | { status: 'ready'; savedRevision: number; model: ResourceModel };

export function PreviousVersionAction<K extends string>({
  commands,
  sections: changedSections,
  sectionOf,
  authored = sameModel,
}: {
  commands: ResourceEditorCommands;
  sections: (paths: readonly string[]) => readonly ChangedSection<K>[];
  sectionOf: (path: string) => K;
  authored?: (model: ResourceModel) => ResourceModel;
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
  const stale = previous.status === 'ready' && previous.savedRevision !== revision;
  const baseModel = state.document.baseModel;
  const compared = useMemo(() => {
    if (!open || previous.status !== 'ready' || stale) return null;
    const before = authored(previous.model);
    const after = authored(baseModel);
    return { before, after, paths: changedValuePaths(before, after) };
  }, [open, previous, stale, baseModel, authored]);
  if (!state.document.targetId) return null;
  const sections = compared ? changedSections(compared.paths) : [];
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
        ) : compared && sections.length ? (
          <>
            <p>{t('shared.comparePreviousHelp')}</p>
            <ChangedSectionList
              label={t('shared.differentSections')}
              sections={sections}
              before={compared.before}
              after={compared.after}
              sectionOf={sectionOf}
            />
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
