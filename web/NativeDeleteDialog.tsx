import { t, useI18n } from './i18n.js';
import { Dialog } from './Dialog.js';
import { CloseIcon } from './ui-icons.js';
import './deletion.css';

export function NativeDeleteDialog({
  target,
  action,
  onCancel,
  onConfirm,
}: {
  target: string | null;
  action: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useI18n();
  return (
    <Dialog
      open={target !== null}
      title={t('shared.deleteConfirm')}
      variant="confirmation"
      role="alertdialog"
      className="delete-dialog"
      onClose={onCancel}
    >
      <p>{t('shared.deleteQuestion', { title: target ?? '' })}</p>
      <div className="form-actions">
        <button type="button" className="secondary" onClick={onCancel}>
          <CloseIcon size={18} aria-hidden="true" />
          {t('shared.cancel')}
        </button>
        <button type="button" className="delete-button" onClick={onConfirm}>
          {action}
        </button>
      </div>
    </Dialog>
  );
}
