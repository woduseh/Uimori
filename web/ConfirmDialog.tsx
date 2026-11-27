import type { ReactNode } from 'react';
import { t, useI18n } from './i18n.js';
import { Dialog } from './Dialog.js';
import { CloseIcon } from './ui-icons.js';
import './deletion.css';

export function ConfirmDialog({
  open,
  title,
  body,
  action,
  busy = false,
  disabled = false,
  children,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  body: string;
  action: string;
  busy?: boolean;
  disabled?: boolean;
  children?: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useI18n();
  return (
    <Dialog
      open={open}
      title={title}
      variant="confirmation"
      role="alertdialog"
      className="delete-dialog"
      onClose={() => {
        if (!busy) onCancel();
      }}
    >
      <p>{body}</p>
      {children}
      <div className="form-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          <CloseIcon size={18} aria-hidden="true" />
          {t('shared.cancel')}
        </button>
        <button
          type="button"
          className="delete-button"
          disabled={busy || disabled}
          onClick={onConfirm}
        >
          {action}
        </button>
      </div>
    </Dialog>
  );
}
