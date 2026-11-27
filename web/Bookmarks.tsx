import { t, useI18n } from './i18n.js';
import { formatUiMessage, UiError, uiMessage, type UiMessage } from './ui-message.js';
import { toUiMessage } from './api-errors.js';
import { LoadingState } from './LoadingState.js';
import {
  createContext,
  useContext,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from 'react';
import { BookmarkCheck, BookmarkPlus, Pencil } from 'lucide-react';
import type { Bookmark } from '../core/reading-state.js';
import type { ReaderTarget } from '../core/reader-target.js';
import { Dialog } from './Dialog.js';
import { DeleteButton } from './DeleteButton.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { IconButton } from './IconButton.js';
import { SaveButton } from './SaveButton.js';
import { TransientNotice } from './TransientNotice.js';
import { personalWorkspaceEndpoints as endpoints } from '#contracts';
import { callEndpoint } from './api.js';
import './bookmarks.css';
import { useRetryableEffect } from './useRetryableEffect.js';

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
  onSaveError,
}: {
  item: Bookmark;
  onSaved: (value: Bookmark) => void;
  onClose: () => void;
  onSaveError?: () => void;
}) {
  useI18n();
  const [title, setTitle] = useState(item.title);
  const [note, setNote] = useState(item.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiMessage | null>(null);
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
    setError(null);
    let attempted = false;
    try {
      if (!title.trim()) throw new UiError(uiMessage('reader.enterABookmarkName'));
      attempted = true;
      onSaved(
        await callEndpoint(endpoints.updateBookmark, {
          id: item.id,
          expectedRevision: item.revision,
          title,
          note,
        })
      );
      return true;
    } catch (caught) {
      setError(toUiMessage(caught));
      if (attempted) onSaveError?.();
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
            } catch {}
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
              {formatUiMessage(error)}
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
  handle,
}: {
  capture: () => { target: ReaderTarget; quote: string } | null;
  title: string;
  disabled?: boolean;
  handle?: Ref<{ add: () => void }>;
}) {
  useI18n();
  const [saved, setSaved] = useState<Bookmark | null>(null);
  const [notice, setNotice] = useState<UiMessage | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiMessage | null>(null);
  const pending = useRef<{
    id: string;
    title: string;
    note: string;
    target: ReaderTarget;
    quote: string;
  } | null>(null);
  const [boundaryId] = useState(() => `bookmark-save:${crypto.randomUUID()}`);
  useBookmarkEditing(boundaryId, busy);
  useImperativeHandle(handle, () => ({ add: () => void add() }));
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
    setError(null);
    setNotice(null);
    try {
      setSaved(
        await callEndpoint(endpoints.addBookmark, {
          ...pending.current,
          chatId: pending.current.target.chatId,
        })
      );
      pending.current = null;
      setNotice(uiMessage('reader.bookmarkAdded'));
    } catch (caught) {
      setError(toUiMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <IconButton
        label={saved ? t('reader.bookmarkAddedEditNote') : t('reader.addBookmark')}
        icon={saved ? BookmarkCheck : BookmarkPlus}
        size={18}
        className="scene-action"
        disabled={disabled || busy}
        onClick={() => void add()}
      />
      <TransientNotice content={notice} />
      {error && (
        <span role="alert" className="error">
          {formatUiMessage(error)}
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
  const [error, setError] = useState<UiMessage | null>(null);
  const [mutationFailed, setMutationFailed] = useState(false);
  const [editing, setEditing] = useState<Bookmark | null>(null);
  const reloadBookmarks = useRetryableEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    setError(null);
    setMutationFailed(false);
    void callEndpoint(endpoints.listBookmarks, { chatId }, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setItems(value);
          setLoaded(true);
          setError(null);
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(toUiMessage(caught));
      });
    return () => controller.abort();
  }, [chatId]);
  return (
    <section className="bookmark-list" aria-label={t('reader.bookmarksInThisChat')}>
      {!loaded && !error && (
        <LoadingState presentation="inline" label={uiMessage('reader.loadingBookmarks')} />
      )}
      {loaded && !items.length && <p>{t('reader.noBookmarksYetAddOneBelowAScene')}</p>}
      {error && (
        <p role="alert" className="error">
          {formatUiMessage(error)}
        </p>
      )}
      {(error || mutationFailed) && (
        <button type="button" onClick={reloadBookmarks}>
          {t('reader.refreshBookmarks')}
        </button>
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
              endpoint={endpoints.deleteBookmark}
              params={{ id: item.id }}
              revision={item.revision}
              title={uiMessage('reader.valueBookmark', { v0: item.title })}
              description={null}
              iconOnly
              onDeleted={() => setItems((old) => old.filter((value) => value.id !== item.id))}
              onError={() => setMutationFailed(true)}
            />
          </div>
        </article>
      ))}
      {editing && (
        <BookmarkEditor
          key={editing.id}
          item={editing}
          onClose={() => setEditing(null)}
          onSaveError={() => setMutationFailed(true)}
          onSaved={(updated) => {
            setItems((old) => old.map((item) => (item.id === updated.id ? updated : item)));
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}
