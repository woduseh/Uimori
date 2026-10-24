import { t, useI18n, translateMessage, message as uiMessage } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BookmarkPlus, Pencil } from 'lucide-react';
import type { Bookmark } from '../core/reading-state.js';
import type { ReaderTarget } from '../core/reader-target.js';
import { Dialog } from './Dialog.js';
import { DeleteButton } from './DeleteButton.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { IconButton } from './IconButton.js';
import { SaveButton } from './SaveButton.js';
import { api } from './api.js';
import './bookmarks.css';

/** Registers reader edits with the existing editing boundary. */
export const ReaderEditingContext = createContext<(id: string, editing: boolean) => void>(() => {});
function useBookmarkEditing(id: string, editing: boolean) {
  const register = useContext(ReaderEditingContext);
  useLayoutEffect(() => {
    if (!editing) return;
    register(id, true);
    return () => register(id, false);
  }, [id, editing, register]);
}

function BookmarkEditor({
  item,
  onSaved,
  onClose,
}: {
  item: Bookmark;
  onSaved: (value: Bookmark) => void;
  onClose: () => void;
}) {
  useI18n();
  const [title, setTitle] = useState(item.title);
  const [note, setNote] = useState(item.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState(false);
  const lock = useRef(false);
  const dirty = title !== item.title || note !== item.note;
  useBookmarkEditing(`bookmark:${item.id}`, dirty || busy);
  function close() {
    if (lock.current) return;
    if (dirty) setDiscard(true);
    else onClose();
  }
  async function save() {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      if (!title.trim()) throw new Error(uiMessage('reader.enterABookmarkName'));
      onSaved(
        await api<Bookmark>(
          `/bookmarks/${item.id}`,
          { expectedRevision: item.revision, title, note },
          'PATCH'
        )
      );
      return true;
    } catch (caught) {
      setError((caught as Error).message);
      throw caught;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function continueEditing() {
    if (!lock.current) setDiscard(false);
  }
  return (
    <>
      {/* Close the nested confirmation first on unmount, then restore the editor opener. */}
      <Dialog
        open={discard}
        title={t('reader.unsavedBookmarkEdits')}
        variant="confirmation"
        role="alertdialog"
        onClose={continueEditing}
      >
        <p>{t('reader.closingDiscardsUnsavedBookmarkEdits')}</p>
        <DraftDiscardActions
          open={discard}
          disabled={busy}
          discardLabel={t('reader.discardEditsAndClose')}
          saveLabel={t('reader.saveAndClose')}
          onContinue={continueEditing}
          onDiscard={() => {
            if (!lock.current) onClose();
          }}
          onSave={save}
        />
      </Dialog>
      <Dialog open title={t('reader.editBookmark')} onClose={close} className="bookmark-dialog">
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              await save();
            } catch {
              // save keeps the error and unsaved input in the editor.
            }
          }}
        >
          <fieldset disabled={busy}>
            <label>
              {t('reader.bookmarkName')}
              <input
                value={title}
                maxLength={200}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label>
              {t('reader.bookmarkNote')}
              <textarea
                value={note}
                maxLength={4000}
                rows={4}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            <SaveButton
              label={t('reader.saveBookmarkChanges')}
              disabled={!title.trim() || !dirty}
              aria-busy={busy}
            />
          </fieldset>
          {error && (
            <p role="alert" className="error">
              {translateMessage(error)}
            </p>
          )}
        </form>
      </Dialog>
    </>
  );
}

export function BookmarkButton({
  capture,
  title,
  disabled,
}: {
  capture: () => { target: ReaderTarget; quote: string } | null;
  title: string;
  disabled?: boolean;
}) {
  useI18n();
  const [saved, setSaved] = useState<Bookmark | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{
    id: string;
    title: string;
    note: string;
    target: ReaderTarget;
    quote: string;
  } | null>(null);
  // The same creation ID survives a lost response; retrying must not create another bookmark.
  const [boundaryId] = useState(() => `bookmark-save:${crypto.randomUUID()}`);
  useBookmarkEditing(boundaryId, busy);
  async function add() {
    if (busy || disabled) return;
    if (saved) {
      setEditing(true);
      return;
    }
    if (!pending.current) {
      const location = capture();
      if (!location) return;
      pending.current = { ...location, id: crypto.randomUUID(), title, note: '' };
    }
    setBusy(true);
    setError('');
    try {
      setSaved(
        await api<Bookmark>(`/chats/${pending.current.target.chatId}/bookmarks`, pending.current)
      );
      pending.current = null;
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <IconButton
        label={saved ? t('reader.bookmarkAddedEditNote') : t('reader.addBookmark')}
        icon={BookmarkPlus}
        size={18}
        className="scene-action"
        disabled={disabled || busy}
        onClick={() => void add()}
      />
      {error && (
        <span role="alert" className="error">
          {translateMessage(error)}
        </span>
      )}
      {saved && editing && (
        <BookmarkEditor
          item={saved}
          onSaved={(value) => {
            setSaved(value);
            setEditing(false);
          }}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}

export function BookmarkList({
  chatId,
  onNavigate,
}: {
  chatId: string;
  onNavigate: (target: ReaderTarget) => void;
}) {
  useI18n();
  const [items, setItems] = useState<Bookmark[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Bookmark | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is an explicit reload.
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    setError('');
    void api<Bookmark[]>(`/chats/${chatId}/bookmarks`, undefined, 'GET', controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setItems(value);
          setLoaded(true);
          setError('');
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(caught.message);
      });
    return () => controller.abort();
  }, [chatId, revision]);
  return (
    <section className="bookmark-list" aria-label={t('reader.bookmarksInThisChat')}>
      {!loaded && !error && (
        <LoadingState presentation="inline" label={t('reader.loadingBookmarks')} />
      )}
      {loaded && !items.length && <p>{t('reader.noBookmarksYetAddOneBelowAScene')}</p>}
      {error && (
        <p role="alert" className="error">
          {translateMessage(error)}
        </p>
      )}
      {items.map((item) => (
        <article key={item.id}>
          <button type="button" className="bookmark-title" onClick={() => onNavigate(item.target)}>
            {item.title}
          </button>
          <small>
            {item.target.representation === 'translation'
              ? t('reader.translation')
              : t('reader.original')}
          </small>
          {item.quote && <blockquote>{item.quote}</blockquote>}
          {item.note && <p>{item.note}</p>}
          <div>
            <IconButton
              label={t('reader.editValueBookmark', { v0: item.title })}
              icon={Pencil}
              onClick={() => setEditing(item)}
            />
            <DeleteButton
              path={`/bookmarks/${item.id}`}
              revision={item.revision}
              title={t('reader.valueBookmark', { v0: item.title })}
              description={t('reader.onlyTheBookmarkIsDeletedTheManuscriptIsPreserved')}
              iconOnly
              onDeleted={() => setItems((old) => old.filter((value) => value.id !== item.id))}
            />
          </div>
        </article>
      ))}
      <button type="button" onClick={() => setRevision((value) => value + 1)}>
        {t('reader.refreshBookmarks')}
      </button>
      {editing && (
        <BookmarkEditor
          key={editing.id}
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setItems((old) => old.map((item) => (item.id === updated.id ? updated : item)));
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}
