import { t, translateMessage, useI18n } from './i18n.js';
import { useRef, useState } from 'react';
import { CloseIcon, DeleteIcon } from './ui-icons.js';
import { api } from './api.js';
import { Dialog } from './Dialog.js';
import { NoticeBanner } from './NoticeBanner.js';
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
  description = '목록에서 삭제해요. 과거 채팅과 실행에서 사용한 내용은 유지돼요.',
  disabled,
  iconOnly = false,
  preparePath,
  body,
  onDeleted,
  onError,
}: Props) {
  useI18n();
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
        aria-label={t('shared.deleteAccessible', { title, action: translateMessage(label) })}
        aria-haspopup="dialog"
        title={iconOnly ? translateMessage(label) : undefined}
        disabled={disabled || busy}
        onClick={() => void open()}
      >
        <DeleteIcon size={iconOnly ? 14 : 18} aria-hidden="true" />
        {!iconOnly && <span>{translateMessage(label)}</span>}
      </button>
      {!target && error && (
        <span className="error" role="alert">
          {translateMessage(error)}
        </span>
      )}
      <Dialog
        open={!!target}
        title={t('shared.deleteConfirm')}
        variant="confirmation"
        role="alertdialog"
        className="delete-dialog"
        onClose={() => {
          if (!lock.current) setTarget(null);
        }}
      >
        <p>{t('shared.deleteQuestion', { title: target?.title ?? '' })}</p>
        <p className="muted">{translateMessage(description)}</p>
        {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setTarget(null)}
          >
            <CloseIcon size={18} aria-hidden="true" />
            {t('shared.cancel')}
          </button>
          <button
            type="button"
            className="delete-button"
            disabled={busy}
            onClick={() => void remove()}
          >
            {busy ? t('shared.deleting') : t('shared.deletePermanently')}
          </button>
        </div>
      </Dialog>
    </span>
  );
}
