import { useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api } from './api.js';
import { Dialog } from './Dialog.js';
import './deletion.css';

type Props = {
  path: string;
  revision?: number;
  title: string;
  label?: string;
  description?: string;
  disabled?: boolean;
  iconOnly?: boolean;
  preparePath?: string;
  body?: Record<string, unknown>;
  onDeleted: () => Promise<void> | void;
  onError?: (message: string) => void;
};
/** Capture the reviewed revision before confirmation; never retry a conflicting deletion. */
export function DeleteButton({
  path,
  revision,
  title,
  label = '삭제',
  description = '저장된 항목과 모든 버전을 삭제해요. 되돌릴 수 없어요. 다른 자료나 채팅에서 사용 중이면 삭제할 수 없는 이유를 안내해요.',
  disabled,
  iconOnly = false,
  preparePath,
  body,
  onDeleted,
  onError,
}: Props) {
  const [target, setTarget] = useState<{
    path: string;
    title: string;
    body: Record<string, unknown>;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const lock = useRef(false);
  async function open() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const request = preparePath
        ? (await api<{ request: Record<string, unknown> }>(preparePath)).request
        : (body ?? (revision === undefined ? {} : { expectedRevision: revision }));
      setTarget({ path, title, body: request });
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message);
      onError?.(message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function remove() {
    if (!target || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await api(target.path, target.body, 'DELETE');
      setTarget(null);
      await onDeleted();
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message);
      onError?.(message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <span className="delete-control">
      <button
        type="button"
        className={`secondary delete-button ${iconOnly ? 'icon-only' : ''}`}
        aria-label={`${title} ${label}`}
        disabled={disabled || busy}
        onClick={() => void open()}
      >
        {iconOnly ? <Trash2 size={14} aria-hidden="true" /> : label}
      </button>
      {!target && error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
      <Dialog
        open={!!target}
        title="삭제 확인"
        role="alertdialog"
        className="delete-dialog"
        onClose={() => {
          if (!lock.current) setTarget(null);
        }}
      >
        <p>
          <strong>{target?.title}</strong> 항목을 삭제할까요?
        </p>
        <p className="muted">{description}</p>
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
            onClick={() => setTarget(null)}
          >
            취소
          </button>
          <button
            type="button"
            className="delete-button"
            disabled={busy}
            onClick={() => void remove()}
          >
            {busy ? '삭제 중…' : '영구 삭제'}
          </button>
        </div>
      </Dialog>
    </span>
  );
}
