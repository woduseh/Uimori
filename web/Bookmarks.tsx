import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BookmarkPlus, Pencil, Trash2 } from 'lucide-react';
import type { Bookmark } from '../core/reading-state.js';
import type { ReaderTarget } from '../core/reader-target.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import { api } from './api.js';
import './bookmarks.css';

/** Registers only bookmark edits with the reader's existing editing boundary. */
export const BookmarkEditingContext = createContext<(id: string, editing: boolean) => void>(
  () => {}
);
function useBookmarkEditing(id: string, editing: boolean) {
  const register = useContext(BookmarkEditingContext);
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
  const [title, setTitle] = useState(item.title);
  const [note, setNote] = useState(item.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = title !== item.title || note !== item.note;
  useBookmarkEditing(`bookmark:${item.id}`, dirty || busy);
  function close() {
    if (busy || (dirty && !window.confirm('저장하지 않은 책갈피 수정을 닫을까요?'))) return;
    onClose();
  }
  return (
    <Dialog open title="책갈피 편집" onClose={close} className="bookmark-dialog">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          try {
            onSaved(
              await api<Bookmark>(
                `/bookmarks/${item.id}`,
                { expectedRevision: item.revision, title, note },
                'PATCH'
              )
            );
          } catch (caught) {
            setError((caught as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy}>
          <label>
            책갈피 이름
            <input
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            책갈피 메모
            <textarea
              value={note}
              maxLength={4000}
              rows={4}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <button type="submit" disabled={!title.trim() || !dirty}>
            {busy ? '저장 중…' : '책갈피 변경 저장'}
          </button>
        </fieldset>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </form>
    </Dialog>
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
        label={saved ? '책갈피 추가됨 · 메모 편집' : '책갈피 추가'}
        icon={BookmarkPlus}
        size={18}
        className="scene-action"
        disabled={disabled || busy}
        onClick={() => void add()}
      />
      {error && (
        <span role="alert" className="error">
          {error}
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
  const [items, setItems] = useState<Bookmark[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Bookmark | null>(null);
  const [busy, setBusy] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is an explicit reload.
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
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
  async function remove(item: Bookmark) {
    if (!window.confirm(`“${item.title}” 책갈피를 삭제할까요? 원고는 유지돼요.`)) return;
    setBusy(true);
    setError('');
    try {
      await api(`/bookmarks/${item.id}`, { expectedRevision: item.revision }, 'DELETE');
      setItems((old) => old.filter((value) => value.id !== item.id));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="bookmark-list" aria-label="이 채팅의 책갈피">
      {!loaded && !error && <p role="status">책갈피를 읽고 있어요…</p>}
      {loaded && !items.length && (
        <p>아직 책갈피가 없어요. 장면 아래에서 책갈피를 추가할 수 있어요.</p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {items.map((item) => (
        <article key={item.id}>
          <button
            type="button"
            className="bookmark-title"
            disabled={busy}
            onClick={() => onNavigate(item.target)}
          >
            {item.title}
          </button>
          <small>{item.target.representation === 'translation' ? '번역' : '원문'}</small>
          {item.quote && <blockquote>{item.quote}</blockquote>}
          {item.note && <p>{item.note}</p>}
          <div>
            <IconButton
              label={`${item.title} 책갈피 편집`}
              icon={Pencil}
              disabled={busy}
              onClick={() => setEditing(item)}
            />
            <IconButton
              label={`${item.title} 책갈피 삭제`}
              icon={Trash2}
              disabled={busy}
              onClick={() => void remove(item)}
            />
          </div>
        </article>
      ))}
      <button type="button" disabled={busy} onClick={() => setRevision((value) => value + 1)}>
        책갈피 새로 고침
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
