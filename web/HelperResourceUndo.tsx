import { useEffect, useRef, useState } from 'react';
import { Undo2 } from 'lucide-react';
import type { HelperResourceEdit } from '../core/helper.js';
import { api } from './api.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import { editorContextChanged, hasUnsavedResourceEditor } from './resource-editor.js';
import './helper-resource-undo.css';

/** The server owns the saved edit and its revision; this control only selects its receipt. */
export function HelperResourceUndo({
  conversationId,
  edit,
  disabled,
  refresh,
}: {
  conversationId: string;
  edit: HelperResourceEdit;
  disabled: boolean;
  refresh: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [restored, setRestored] = useState(false);
  const [dirty, setDirty] = useState(() => hasUnsavedResourceEditor(edit.kind, edit.id));
  const alive = useRef(true);
  const locked = useRef(false);
  useEffect(() => {
    if (edit.undone) {
      setError('');
      setConfirming(false);
    }
  }, [edit.undone]);
  useEffect(() => {
    alive.current = true;
    const changed = () => setDirty(hasUnsavedResourceEditor(edit.kind, edit.id));
    changed();
    window.addEventListener(editorContextChanged, changed);
    return () => {
      alive.current = false;
      window.removeEventListener(editorContextChanged, changed);
    };
  }, [edit.kind, edit.id]);
  const undone = restored || edit.undone;
  const reason = dirty ? '이 자료의 편집을 저장하거나 취소한 뒤 되돌려 주세요.' : edit.reason;
  const unavailable = disabled || busy || dirty || !edit.canUndo || !!undone;
  async function undo() {
    if (unavailable || locked.current) return;
    if (hasUnsavedResourceEditor(edit.kind, edit.id)) {
      setDirty(true);
      return;
    }
    locked.current = true;
    setBusy(true);
    setError('');
    let accepted = false;
    try {
      const result = await api<HelperResourceEdit>(
        `/helper/conversations/${encodeURIComponent(conversationId)}/undo-resource`,
        { editSeq: edit.editSeq }
      );
      accepted = result.undone === true;
      if (!accepted) throw new Error('되돌린 결과를 확인하지 못했어요.');
      // Notify other saved-resource owners even if this conversation was switched meanwhile.
      window.dispatchEvent(new Event('uimori-helper-updated'));
      if (edit.kind === 'theme') window.dispatchEvent(new Event('uimori-themes-changed'));
      if (edit.kind === 'illustration-preset')
        window.dispatchEvent(new Event('uimori-illustration-presets-changed'));
      if (alive.current) {
        setRestored(true);
        setConfirming(false);
      }
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : '되돌린 결과를 확인하지 못했어요.');
    } finally {
      // A lost response is reconciled by a read, never by automatically posting again.
      try {
        await refresh();
      } catch {
        if (alive.current)
          setError(
            accepted
              ? '수정은 되돌렸지만 화면을 새로 불러오지 못했어요.'
              : '저장 상태를 확인하지 못했어요. 대화를 다시 열어 확인해 주세요.'
          );
      }
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="helper-resource-undo" aria-label="도우미 최근 자료 수정">
      <div>
        <span role={undone ? 'status' : undefined}>
          {undone ? '수정 되돌림' : '최근 수정'} · {edit.title}
        </span>
        {!undone && (
          <IconButton
            icon={Undo2}
            label="마지막 자료 수정 되돌리기"
            title={reason || '수정 직전 저장본으로 되돌리기'}
            disabled={unavailable}
            className="secondary"
            onClick={() => setConfirming(true)}
          />
        )}
      </div>
      {!undone && reason && <small>{reason}</small>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <Dialog
        open={confirming && !undone}
        title="자료 수정 되돌리기"
        variant="confirmation"
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
      >
        <p>‘{edit.title}’을 도우미 수정 직전 저장본으로 되돌릴까요?</p>
        {reason && <p role="status">{reason}</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            취소
          </button>
          <button type="button" disabled={unavailable} onClick={() => void undo()}>
            {busy ? '되돌리는 중…' : '되돌리기'}
          </button>
        </div>
      </Dialog>
    </section>
  );
}
