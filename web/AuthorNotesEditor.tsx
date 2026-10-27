import { t, useI18n, translateMessage, message as uiMessage } from './i18n.js';
import { TransientNotice } from './TransientNotice.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { AddIcon, BackIcon, CloseIcon, EditIcon, PowerIcon } from './ui-icons.js';
import { useEffect, useRef, useState } from 'react';
import type { AuthorNote, ImportedMemoryOrigin } from '../core/notes.js';
import { ApiError } from './api.js';
import { SaveConflictDialog } from './SaveConflictDialog.js';
import { SaveButton } from './SaveButton.js';

type AuthorNoteCommand = {
  expectedHeadRevision: string | null;
  expectedRevision: number;
  idempotencyKey: string;
  author: string;
  text: string;
  replacesId?: string;
  retired?: true;
  kind?: AuthorNote['kind'];
  origin?: ImportedMemoryOrigin;
};
type NoteDraft = {
  originalId: string | null;
  revision: number;
  headRevision: string | null;
  text: string;
  author: string;
  kind: AuthorNote['kind'];
  origin?: ImportedMemoryOrigin;
};

/** User-authored instructions remain separate from derived summaries and fictional events. */
export function AuthorNotesEditor({
  headRevision,
  notes,
  revision,
  onSave,
  onRefresh,
  onError,
  onDirtyChange,
  onSaveHandlerChange,
  disabled = false,
}: {
  headRevision: string | null;
  notes: AuthorNote[];
  revision: number;
  onSave: (command: AuthorNoteCommand) => Promise<void>;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
  disabled?: boolean;
}) {
  useI18n();
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [retiring, setRetiring] = useState<NoteDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const reviewed = useRef<{
    revision: number;
    headRevision: string | null;
    originalExists: boolean;
  } | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const alive = useRef(true);
  const locked = useRef(false);
  const commandKey = useRef({ fingerprint: '', key: crypto.randomUUID() });
  const editing = draft ?? retiring;
  const originalExists =
    !editing?.originalId || notes.some((note) => note.id === editing.originalId);
  const conflict = Boolean(
    editing &&
      (editing.revision !== revision || editing.headRevision !== headRevision || !originalExists)
  );
  useEffect(() => {
    onDirtyChange(draft !== null || retiring !== null || busy);
  }, [draft, retiring, busy, onDirtyChange]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      onDirtyChange(false);
    };
  }, [onDirtyChange]);
  const fromNote = (note?: AuthorNote): NoteDraft => ({
    originalId: note?.id ?? null,
    revision,
    headRevision,
    text: note?.text ?? '',
    author: note?.declaration.author ?? '사용자',
    kind: note?.kind ?? 'author-note',
    ...(note?.origin ? { origin: note.origin } : {}),
  });
  function begin(note?: AuthorNote) {
    setDraft(fromNote(note));
    setRetiring(null);
    setError('');
    setMessage('');
  }
  async function refresh() {
    try {
      await onRefresh();
    } catch {
      if (!alive.current) return;
      const text = uiMessage('library.couldNotRefreshNotesYourInputAnd');
      setError(text);
      onError(text);
    }
  }
  async function save(value: NoteDraft, retired = false) {
    if (locked.current || disabled) return false;
    if (conflict) {
      setConflictOpen(true);
      return false;
    }
    if (
      !retired &&
      (!value.text.trim() ||
        !value.author.trim() ||
        value.text.length > 32000 ||
        value.author.length > 200)
    )
      return false;
    const command = {
      expectedRevision: value.revision,
      expectedHeadRevision: value.headRevision,
      text: retired ? '' : value.text,
      author: value.author,
      ...(value.kind === 'imported-memory' ? { kind: value.kind, origin: value.origin } : {}),
      ...(value.originalId ? { replacesId: value.originalId } : {}),
      ...(retired ? { retired: true as const } : {}),
    };
    const fingerprint = JSON.stringify(command);
    if (commandKey.current.fingerprint !== fingerprint)
      commandKey.current = { fingerprint, key: crypto.randomUUID() };
    locked.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await onSave({ ...command, idempotencyKey: commandKey.current.key });
      if (!alive.current) return false;
      setDraft(null);
      setRetiring(null);
      commandKey.current = { fingerprint: '', key: crypto.randomUUID() };
      setMessage(
        retired
          ? uiMessage('library.thisNoteWillNoLongerBeUsed')
          : uiMessage('library.noteSavedItAppliesToFutureRequests')
      );
      await refresh();
      return true;
    } catch (caught) {
      if (!alive.current) return false;
      const text = caught instanceof Error ? caught.message : t('library.couldNotSaveTheNote');
      setError(text);
      onError(text);
      if (caught instanceof ApiError && caught.status === 409) {
        setConflictOpen(true);
        await refresh();
      }
      return false;
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  useSettingsSaveHandler(onSaveHandlerChange, async () => {
    if (retiring) throw new Error(uiMessage('library.confirmRetiringThisNoteInContinueEditing'));
    if (locked.current || busy) return false;
    return draft ? save(draft) : true;
  });
  return (
    <details className="context-notes" data-testid="context-notes">
      <summary>
        {t('library.notesSummary', {
          count: notes.length,
          imported: notes.some((note) => note.kind === 'imported-memory') ? 'yes' : 'no',
        })}
      </summary>
      {error && (
        <p className="error" role="alert">
          {translateMessage(error)}
        </p>
      )}
      <TransientNotice message={message} />
      {notes.length > 0 && (
        <ul className="story-records">
          {notes.map((note) => (
            <li key={note.id}>
              <p>{note.text}</p>
              <small>
                {t('library.noteAttribution', {
                  imported: note.kind === 'imported-memory' ? 'yes' : 'no',
                  origin: note.origin?.title ?? '',
                  author: note.declaration.author,
                  linked: note.atRevision ? 'yes' : 'no',
                })}
              </small>
              <div className="form-actions">
                <button
                  type="button"
                  className="secondary"
                  aria-label={t('library.editNote', { v0: note.text.slice(0, 60) })}
                  disabled={busy || disabled || editing !== null}
                  onClick={() => begin(note)}
                >
                  <EditIcon size={18} aria-hidden="true" />
                  {t('library.edit2')}
                </button>
                <button
                  type="button"
                  className="secondary"
                  aria-label={t('library.retireNote', { v0: note.text.slice(0, 60) })}
                  disabled={busy || disabled || editing !== null}
                  onClick={() => {
                    setRetiring(fromNote(note));
                    setError('');
                    setMessage('');
                  }}
                >
                  <PowerIcon size={18} aria-hidden="true" />
                  {t('library.retire')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {!editing && (
        <button type="button" className="secondary" disabled={disabled} onClick={() => begin()}>
          <AddIcon size={18} aria-hidden="true" />
          {t('library.addNote')}
        </button>
      )}
      {conflict && (
        <div className="context-conflict" role="alert">
          <p>{t('library.theSavedNoteOrTargetSceneChanged')}</p>
          <button
            type="button"
            className="secondary"
            disabled={busy || disabled}
            onClick={() => setConflictOpen(true)}
          >
            {t('library.reviewSaveConflict')}
          </button>
        </div>
      )}
      {draft && (
        <form
          className="editor-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void save(draft);
          }}
        >
          <label>
            {t('library.noteAuthor')}
            <input
              required
              maxLength={200}
              value={draft.author}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, author: event.target.value })}
            />
          </label>
          <label className="full">
            {t('library.noteOrCorrection')}
            <textarea
              required
              maxLength={32000}
              value={draft.text}
              disabled={busy}
              rows={5}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })}
            />
          </label>
          <div className="form-actions full">
            <SaveButton
              className="primary"
              label={draft.originalId ? t('library.saveEditedNote') : t('library.saveNewNote')}
              aria-busy={busy}
              disabled={busy || disabled || !draft.text.trim() || !draft.author.trim()}
            />
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setError('');
              }}
            >
              <CloseIcon size={18} aria-hidden="true" />
              {t('library.cancelEditing')}
            </button>
          </div>
        </form>
      )}
      <SaveConflictDialog
        open={conflictOpen}
        title={t('library.noteSaveConflict')}
        onClose={() => {
          setConflictOpen(false);
          reviewed.current = null;
        }}
        readSaved={async () => {
          reviewed.current = { revision, headRevision, originalExists };
          return () => ({
            content: (
              <>
                {notes.length ? (
                  notes.map((note) => <blockquote key={note.id}>{note.text}</blockquote>)
                ) : (
                  <p>{t('library.noSavedNotes')}</p>
                )}
              </>
            ),
          });
        }}
        onAcceptSaved={
          draft || originalExists
            ? () => {
                const saved = reviewed.current;
                if (!saved) return;
                const update = (current: NoteDraft | null) =>
                  current
                    ? {
                        ...current,
                        revision: saved.revision,
                        headRevision: saved.headRevision,
                        ...(!saved.originalExists ? { originalId: null } : {}),
                      }
                    : null;
                setDraft(update);
                if (saved.originalExists) setRetiring(update);
                setError('');
              }
            : undefined
        }
      />
      {retiring && (
        <div role="group" aria-label={t('library.confirmNoteRetirement')}>
          <p>{t('library.excludeThisNoteFromFutureRequestsFor')}</p>
          <blockquote>{retiring.text}</blockquote>
          <div className="form-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy || disabled}
              onClick={() => void save(retiring, true)}
            >
              {t('library.confirmedRetire')}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setRetiring(null);
                setError('');
              }}
            >
              <BackIcon size={18} aria-hidden="true" />
              {t('library.back')}
            </button>
          </div>
        </div>
      )}
    </details>
  );
}
