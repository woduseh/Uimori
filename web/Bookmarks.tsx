import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BookmarkPlus, Pencil } from 'lucide-react';
import type { Bookmark } from '../core/reading-state.js';
import type { ReaderTarget } from '../core/reader-target.js';
import { Dialog } from './Dialog.js';
import { DeleteButton } from './DeleteButton.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { IconButton } from './IconButton.js';
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
      if (!title.trim()) throw new Error('책갈피 이름을 입력해 주세요.');
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
        title="미저장 책갈피 확인"
        variant="confirmation"
        role="alertdialog"
        onClose={continueEditing}
      >
        <p>닫으면 저장하지 않은 책갈피 편집 내용이 사라져요.</p>
        <DraftDiscardActions
          open={discard}
          disabled={busy}
          discardLabel="수정 버리고 닫기"
          saveLabel="저장하고 닫기"
          onContinue={continueEditing}
          onDiscard={() => {
            if (!lock.current) onClose();
          }}
          onSave={save}
        />
      </Dialog>
      <Dialog open title="책갈피 편집" onClose={close} className="bookmark-dialog">
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
          <button type="button" className="bookmark-title" onClick={() => onNavigate(item.target)}>
            {item.title}
          </button>
          <small>{item.target.representation === 'translation' ? '번역' : '원문'}</small>
          {item.quote && <blockquote>{item.quote}</blockquote>}
          {item.note && <p>{item.note}</p>}
          <div>
            <IconButton
              label={`${item.title} 책갈피 편집`}
              icon={Pencil}
              onClick={() => setEditing(item)}
            />
            <DeleteButton
              path={`/bookmarks/${item.id}`}
              revision={item.revision}
              title={`${item.title} 책갈피`}
              description="책갈피만 삭제해요. 원고는 유지돼요."
              iconOnly
              onDeleted={() => setItems((old) => old.filter((value) => value.id !== item.id))}
            />
          </div>
        </article>
      ))}
      <button type="button" onClick={() => setRevision((value) => value + 1)}>
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
