import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatNumber, t, translateMessage, useI18n } from './i18n.js';
import { uiMessage, legacyUiMessage } from './ui-message.js';
import { IconButton } from './IconButton.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { SaveButton } from './SaveButton.js';
import { CloseIcon, EditIcon, HistoryIcon } from './ui-icons.js';
import { ChangeReview } from './ChangeReview.js';
import {
  canRevert,
  changeTarget,
  reviewSections,
  type ChangeTarget,
  type ReviewCard,
} from './change-review.js';
import { changedValuePaths, editorFieldChanges, revertEditorChange } from './editor-values.js';
import type { ResourceModel } from '../core/resource-editing.js';
import type { ResourceEditorCommands } from './resource-editor.js';
import type { ChangedSection } from './studio-sections.js';

export type EditorChangeSave = {
  run: () => Promise<boolean>;
  label: string;
  disabled: boolean;
  error: string;
};

const sectionsKey = (sections: readonly ChangedSection<string>[]) =>
  sections.map((section) => `${section.id}:${section.pending}:${section.title}`).join('|');

function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export function EditorChanges<K extends string>({
  commands,
  changes,
  current,
  subject,
  sectionOf,
  save,
  onReveal,
}: {
  commands: ResourceEditorCommands;
  changes: readonly ChangedSection<K>[];
  current: ResourceModel;
  subject: string;
  sectionOf: (path: string) => K;
  save: EditorChangeSave;
  onReveal: (target: ChangeTarget<K>) => void;
}) {
  useI18n();
  const [open, setOpen] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [undo, setUndo] = useState<{
    previous: ResourceModel;
    next: ResourceModel;
    name: string;
  } | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const reveal = useRef<ChangeTarget<K> | null>(null);
  const { state, session } = commands.value;
  const base = state.document.baseModel;
  const placer = useLatest(sectionOf);
  const shown = useRef({ key: '', changes });
  const key = sectionsKey(changes);
  if (shown.current.key !== key) shown.current = { key, changes };
  const stableChanges = shown.current.changes;
  const sections = useMemo(
    () =>
      open ? reviewSections(stableChanges, editorFieldChanges(base, current), placer.current) : [],
    [open, base, current, stableChanges, placer]
  );
  const label = t('shared.changeCount', { count: changes.length });
  const titleField = () =>
    opener.current
      ?.closest('.editor-studio')
      ?.querySelector<HTMLElement>('.editor-title-field input') ?? null;
  const close = () => {
    setOpen(false);
    setUndo(null);
  };
  const discard = () => {
    const title = titleField();
    close();
    void commands.discard().then(() => title?.focus());
  };
  const revert = (card: ReviewCard<K>) => {
    const previous = session.snapshot().local.model;
    const next = [card.change, ...card.related].reduce(
      (model, change) => revertEditorChange(model, base, change),
      previous
    );
    session.setModel(next);
    setUndo({ previous, next: session.snapshot().local.model, name: card.name });
  };
  const undoShown = !!undo && current === undo.next;
  return (
    <>
      {state.dirty && (
        <button
          ref={opener}
          type="button"
          className="ghost resource-editor-changes"
          aria-haspopup="dialog"
          onClick={() => {
            setAttempted(false);
            setOpen(true);
          }}
        >
          <EditIcon size={18} aria-hidden="true" />
          <span className="resource-editor-changes-label">{label}</span>
          <span className="resource-editor-changes-count" aria-hidden="true">
            {formatNumber(changes.length)}
          </span>
        </button>
      )}
      <ChangeReview
        open={open}
        onClose={close}
        onAfterClose={() => {
          const target = reveal.current;
          reveal.current = null;
          if (target) onReveal(target);
          else if (!session.snapshot().dirty) titleField()?.focus();
        }}
        subject={subject}
        sections={state.dirty || undoShown ? sections : []}
        notice={
          undoShown && (
            <div className="change-review-undo" role="status">
              <span>{t('shared.revertedChange', { title: undo.name })}</span>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  session.setModel(undo.previous);
                  setUndo(null);
                }}
              >
                {t('shared.undoRevert')}
              </button>
            </div>
          )
        }
        onJump={(card) => {
          reveal.current = changeTarget(card);
          close();
        }}
        onRevert={revert}
        revertable={canRevert}
        error={
          attempted &&
          save.error && (
            <p className="error change-review-error" role="alert">
              {translateMessage(save.error)}
            </p>
          )
        }
        actions={
          <>
            <button
              type="button"
              className="secondary change-review-discard"
              disabled={state.saving || !commands.canDiscard}
              onClick={discard}
            >
              <CloseIcon size={18} aria-hidden="true" />
              {t('shared.discardAllEdits')}
            </button>
            <button type="button" className="secondary" onClick={close}>
              {t('shared.closeAction')}
            </button>
            <SaveButton
              type="button"
              className="primary"
              label={save.label}
              text={t('shared.save')}
              disabled={save.disabled || !state.dirty}
              aria-busy={state.saving}
              onClick={async () => {
                setAttempted(true);
                if (await save.run()) close();
              }}
            />
          </>
        }
      />
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
  subject,
  sections: changedSections,
  sectionOf,
  authored = sameModel,
}: {
  commands: ResourceEditorCommands;
  subject: string;
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
  const latest = useLatest({ changedSections, sectionOf });
  const compared = useMemo(() => {
    if (!open || previous.status !== 'ready' || stale) return null;
    const before = authored(previous.model);
    const after = authored(baseModel);
    const { changedSections: place, sectionOf: owner } = latest.current;
    return reviewSections(
      place(changedValuePaths(before, after)),
      editorFieldChanges(before, after),
      owner
    );
  }, [open, previous, stale, baseModel, authored, latest]);
  if (!state.document.targetId) return null;
  const sections = compared ?? [];
  const close = () => {
    if (!busy) setOpen(false);
  };
  const status =
    previous.status === 'loading' || previous.status === 'failed' ? (
      <LoadingState
        presentation="inline"
        label={uiMessage('shared.loadingPrevious')}
        error={previous.status === 'failed' ? legacyUiMessage(previous.error) : null}
        onRetry={load}
      />
    ) : previous.status === 'none' ? (
      <p>{t('shared.noPreviousVersion')}</p>
    ) : stale ? (
      <p role="alert">{t('shared.previousChanged')}</p>
    ) : !sections.length ? (
      <p>{t('shared.previousSame')}</p>
    ) : undefined;
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
      <ChangeReview
        open={open}
        onClose={close}
        title={t('shared.comparePrevious')}
        subject={subject}
        sections={sections}
        status={status}
        help={t('shared.comparePreviousHelp')}
        error={
          error && (
            <p className="error change-review-error" role="alert">
              {translateMessage(error)}
            </p>
          )
        }
        actions={
          <>
            <button type="button" className="secondary" disabled={busy} onClick={close}>
              {t('shared.closeAction')}
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
                <HistoryIcon size={18} aria-hidden="true" />
                {t('shared.restorePrevious')}
              </button>
            )}
          </>
        }
      />
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
