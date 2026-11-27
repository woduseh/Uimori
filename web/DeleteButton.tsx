import { t, useI18n, type MessageReference } from './i18n.js';
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { CloseIcon, DeleteIcon } from './ui-icons.js';
import type { Endpoint, EndpointInput } from '#contracts';
import { api, callEndpoint } from './api.js';
import { Dialog } from './Dialog.js';
import { NoticeBanner } from './NoticeBanner.js';
import { toUiMessage } from './api-errors.js';
import {
  displayMessage,
  formatUiMessage,
  isUiMessage,
  legacyMessageString,
  uiMessage,
  type DisplayMessage,
  type UiMessage,
} from './ui-message.js';
import './deletion.css';

type Title = string | MessageReference | UiMessage;
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
  label?: DisplayMessage;
  confirmLabel?: DisplayMessage;
  description?: DisplayMessage;
  disabled?: boolean;
  iconOnly?: boolean;
  onDeleted: () => Promise<void> | void;
  onError?: (message: string) => void;
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
    body: Record<string, unknown>;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<UiMessage | null>(null);
  const lock = useRef(false);
  const titleValue = (value: Title) => (isUiMessage(value) ? formatUiMessage(value) : value);
  function fail(caught: unknown) {
    const shown = toUiMessage(caught);
    setError(shown);
    onError?.(legacyMessageString(shown));
  }
  async function open() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const revisionBody = revision === undefined ? {} : { expectedRevision: revision };
      const body = request.preparePath
        ? (await api<{ request: Record<string, unknown> }>(request.preparePath)).request
        : (request.body ?? revisionBody);
      setTarget({ title, body });
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
      if (request.endpoint)
        await sendDelete(request.endpoint, { ...request.params, ...target.body });
      else await api(request.path!, target.body, 'DELETE');
      flushSync(() => setTarget(null));
      await onDeleted();
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
          action: displayMessage(label),
        })}
        aria-haspopup="dialog"
        title={iconOnly ? displayMessage(label) : undefined}
        disabled={disabled || busy}
        onClick={() => void open()}
      >
        <DeleteIcon size={iconOnly ? 14 : 18} aria-hidden="true" />
        {!iconOnly && <span>{displayMessage(label)}</span>}
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
        {description && <p className="muted">{displayMessage(description)}</p>}
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
            {busy ? t('shared.deleting') : displayMessage(confirmLabel ?? label)}
          </button>
        </div>
      </Dialog>
    </span>
  );
}
