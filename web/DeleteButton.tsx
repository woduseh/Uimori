import { t, useI18n } from './i18n.js';
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { CloseIcon, DeleteIcon } from './ui-icons.js';
import type { Endpoint, EndpointInput } from '#contracts';
import { api, callEndpoint } from './api.js';
import { Dialog } from './Dialog.js';
import { NoticeBanner } from './NoticeBanner.js';
import { toUiMessage } from './api-errors.js';
import { formatUiMessage, isUiMessage, uiMessage, type UiMessage } from './ui-message.js';
import './deletion.css';

type Title = string | UiMessage;
type Target<E extends Endpoint> =
  | {
      endpoint: E;
      params: Omit<EndpointInput<E>, 'expectedRevision'>;
      path?: never;
      preparePath?: never;
      body?: never;
    }
  | { path: string; preparePath?: string; body?: Record<string, unknown>; endpoint?: never };
type Props<E extends Endpoint> = Target<E> & {
  revision?: number;
  title: Title;
  label?: UiMessage;
  confirmLabel?: UiMessage;
  description?: UiMessage | null;
  disabled?: boolean;
  iconOnly?: boolean;
  onDeleted: () => Promise<void> | void;
  onError?: (error: UiMessage) => void;
};
const sendDelete = callEndpoint as (
  endpoint: Endpoint,
  input: Record<string, unknown>
) => Promise<unknown>;

export function DeleteButton<E extends Endpoint>(props: Props<E>) {
  const request = props as {
    endpoint?: Endpoint;
    params?: Record<string, unknown>;
    path?: string;
    preparePath?: string;
    body?: Record<string, unknown>;
  };
  const {
    revision,
    title,
    label = uiMessage('shared.delete'),
    confirmLabel,
    description = uiMessage('shared.deleteDescription'),
    disabled,
    iconOnly = false,
    onDeleted,
    onError,
  } = props;
  useI18n();
  const [target, setTarget] = useState<{
    title: Title;
    send: () => Promise<unknown>;
    onDeleted: () => Promise<void> | void;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<UiMessage | null>(null);
  const lock = useRef(false);
  const titleValue = (value: Title) => (isUiMessage(value) ? formatUiMessage(value) : value);
  function fail(caught: unknown) {
    const shown = toUiMessage(caught);
    setError(shown);
    onError?.(shown);
  }
  async function open() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const { endpoint, params, path, preparePath } = request;
      const revisionBody = revision === undefined ? {} : { expectedRevision: revision };
      const body = preparePath
        ? (await api<{ request: Record<string, unknown> }>(preparePath)).request
        : (request.body ?? revisionBody);
      const send = endpoint
        ? () => sendDelete(endpoint, { ...params, ...body })
        : () => api(path!, body, 'DELETE');
      setTarget({ title, send, onDeleted });
    } catch (caught) {
      fail(caught);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function remove() {
    if (!target || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await target.send();
      flushSync(() => setTarget(null));
      await target.onDeleted();
    } catch (caught) {
      fail(caught);
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
        aria-label={t('shared.deleteAccessible', {
          title: titleValue(title),
          action: formatUiMessage(label),
        })}
        aria-haspopup="dialog"
        title={iconOnly ? formatUiMessage(label) : undefined}
        disabled={disabled || busy}
        onClick={() => void open()}
      >
        <DeleteIcon size={iconOnly ? 14 : 18} aria-hidden="true" />
        {!iconOnly && <span>{formatUiMessage(label)}</span>}
      </button>
      {!target && error && (
        <span className="error" role="alert">
          {formatUiMessage(error)}
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
        <p>{t('shared.deleteQuestion', { title: target ? titleValue(target.title) : '' })}</p>
        {description && <p className="muted">{formatUiMessage(description)}</p>}
        {error && <NoticeBanner tone="error">{error}</NoticeBanner>}
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
            {busy ? t('shared.deleting') : formatUiMessage(confirmLabel ?? label)}
          </button>
        </div>
      </Dialog>
    </span>
  );
}
