import { useContext, useLayoutEffect, useRef, useState } from 'react';
import type { ReaderNavigationItem } from '../core/types.js';
import { api } from './api.js';
import { Dialog } from './Dialog.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { BookmarkEditingContext } from './Bookmarks.js';

export function SceneTitleEditor({
  item,
  onClose,
}: {
  item: ReaderNavigationItem;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(item.title ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState(false);
  const lock = useRef(false);
  const dirty = title !== (item.title ?? '');
  const registerEditing = useContext(BookmarkEditingContext);
  useLayoutEffect(() => {
    if (!dirty && !busy) return;
    const id = `scene-title:${item.id}`;
    registerEditing(id, true);
    return () => registerEditing(id, false);
  }, [dirty, busy, item.id, registerEditing]);
  async function save() {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await api(`/sources/${item.id}/title`, { title, expectedTitle: item.title ?? '' }, 'PATCH');
      onClose();
      return true;
    } catch (cause) {
      setError((cause as Error).message);
      throw cause;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <Dialog
        open={discard}
        title="미저장 장면 이름"
        variant="confirmation"
        role="alertdialog"
        onClose={() => {
          if (!lock.current) setDiscard(false);
        }}
      >
        <p>저장하지 않은 장면 이름을 버릴까요?</p>
        <DraftDiscardActions
          open={discard}
          disabled={busy}
          discardLabel="수정 버리고 닫기"
          saveLabel="저장하고 닫기"
          onContinue={() => setDiscard(false)}
          onDiscard={onClose}
          onSave={save}
        />
      </Dialog>
      <Dialog
        open
        title="장면 이름"
        onClose={() => {
          if (lock.current) return;
          if (dirty) setDiscard(true);
          else onClose();
        }}
      >
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              await save();
            } catch {
              /* Keep the name and error for correction. */
            }
          }}
        >
          <fieldset disabled={busy}>
            <label>
              장면 이름
              <input
                value={title}
                maxLength={200}
                placeholder={item.label}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <small>비워 두면 연결된 구성 제목이나 요청을 표시해요.</small>
            <div className="form-actions">
              <button type="submit" disabled={!dirty}>
                {busy ? '저장 중…' : '이름 저장'}
              </button>
            </div>
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
