import { t, useI18n } from './i18n.js';
import type { CodexContentWarningGate } from './useCodexContentWarning.js';
import { Dialog } from './Dialog.js';

export function CodexContentWarningDialog({ gate }: { gate: CodexContentWarningGate }) {
  useI18n();
  const translation = gate.warning === 'translation';
  const revision = gate.warning === 'selection-revision';
  return (
    <Dialog
      open={gate.warning !== null}
      title={t('providers.m467')}
      variant="confirmation"
      role="alertdialog"
      onClose={gate.cancelRequest}
    >
      <p>
        {translation ? t('providers.m468') : revision ? t('providers.m469') : t('providers.m470')}
      </p>
      <p className="muted">{t('providers.m471')}</p>
      <div className="form-actions">
        <button type="button" className="secondary" onClick={gate.cancelRequest}>
          {t('providers.m472')}
        </button>
        <button type="button" className="primary" onClick={gate.continueRequest}>
          {t('providers.m473')}
        </button>
      </div>
    </Dialog>
  );
}
