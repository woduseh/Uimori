import { useEffect, useRef, useState } from 'react';
import { BookmarkPlus, Pencil, Trash2 } from 'lucide-react';
import type { Bookmark } from '../core/reading-state.js';
import type { ReaderTarget } from '../core/reader-target.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import { api } from './api.js';
import './bookmarks.css';

export function BookmarkButton({
  capture,
  title,
  disabled,
}: {
  capture: () => { target: ReaderTarget; quote: string } | null;
  title: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<{
    id: string;
    target: ReaderTarget;
    title: string;
    note: string;
    quote: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const initialTitle = useRef('');
  function open() {
    const location = capture();
    if (!location) return;
    initialTitle.current = title;
    setDraft({ ...location, id: crypto.randomUUID(), title, note: '' });
    setSaved(false);
    setError('');
  }
  function close() {
    if (busy) return;
    if (
      draft &&
      (draft.title !== initialTitle.current || draft.note) &&
      !window.confirm('저장하지 않은 책갈피 메모를 닫을까요?')
    )
      return;
    setDraft(null);
  }
  async function save() {
    if (!draft || busy) return;
    setBusy(true);
    setError('');
    try {
      await api<Bookmark>(`/chats/${draft.target.chatId}/bookmarks`, draft);
      setDraft(null);
      setSaved(true);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <IconButton
        label={saved ? '책갈피 추가됨 · 다른 책갈피 추가' : '책갈피 추가'}
        icon={BookmarkPlus}
        size={18}
        className="scene-action"
        disabled={disabled}
        onClick={open}
      />
      <Dialog open={!!draft} title="책갈피 추가" onClose={close} className="bookmark-dialog">
        {draft && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label>
              책갈피 이름
              <input
                value={draft.title}
                maxLength={200}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              />
            </label>
            <label>
              책갈피 메모
              <textarea
                value={draft.note}
                maxLength={4000}
                rows={4}
                onChange={(event) => setDraft({ ...draft, note: event.target.value })}
              />
            </label>
            {draft.quote && <blockquote>{draft.quote}</blockquote>}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button type="submit" disabled={busy || !draft.title.trim()}>
              {busy ? '저장 중…' : '책갈피 저장'}
            </button>
          </form>
        )}
      </Dialog>
    </>
  );
}
export function BookmarkList({
  chatId,
  branchId,
  onNavigate,
}: {
  chatId: string;
  branchId?: string;
  onNavigate: (target: ReaderTarget) => void;
}) {
  const [items, setItems] = useState<Bookmark[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Bookmark | null>(null);
  const [busy, setBusy] = useState(false);
  const original = useRef<Bookmark | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision represents an explicit reload, not a saved bookmark revision.
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    void api<Bookmark[]>(
      `/chats/${chatId}/bookmarks?${new URLSearchParams(branchId ? { branchId } : {})}`,
      undefined,
      'GET',
      controller.signal
    )
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
  }, [chatId, branchId, revision]);
  function close() {
    if (busy) return;
    if (
      editing &&
      (editing.title !== original.current?.title || editing.note !== original.current?.note) &&
      !window.confirm('저장하지 않은 책갈피 수정을 닫을까요?')
    )
      return;
    setEditing(null);
  }
  async function save() {
    if (!editing || busy) return;
    setBusy(true);
    setError('');
    try {
      const updated = await api<Bookmark>(
        `/bookmarks/${editing.id}`,
        { expectedRevision: editing.revision, title: editing.title, note: editing.note },
        'PATCH'
      );
      setItems((old) => old.map((item) => (item.id === updated.id ? updated : item)));
      setEditing(null);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }
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
              disabled={busy}
              onClick={() => {
                original.current = item;
                setEditing({ ...item });
              }}
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
      <Dialog open={!!editing} title="책갈피 편집" onClose={close} className="bookmark-dialog">
        {editing && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label>
              책갈피 이름
              <input
                maxLength={200}
                value={editing.title}
                onChange={(event) => setEditing({ ...editing, title: event.target.value })}
              />
            </label>
            <label>
              책갈피 메모
              <textarea
                maxLength={4000}
                rows={4}
                value={editing.note}
                onChange={(event) => setEditing({ ...editing, note: event.target.value })}
              />
            </label>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button type="submit" disabled={busy || !editing.title.trim()}>
              책갈피 변경 저장
            </button>
          </form>
        )}
      </Dialog>
    </section>
  );
}
