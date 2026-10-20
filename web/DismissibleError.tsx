import { translateMessage, useI18n, t } from './i18n.js';
import { CloseIcon } from './ui-icons.js';
import { IconButton } from './IconButton.js';
import { NoticeBanner } from './NoticeBanner.js';
import './dismissible-error.css';

export function DismissibleError({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  useI18n();
  if (!message) return null;
  const historyOmitted = message === 'PROMPT_HISTORY_OMITTED';
  return (
    <NoticeBanner
      tone="error"
      className="dismissible-error"
      actions={<IconButton label={t('shared.dismissError')} icon={CloseIcon} onClick={onDismiss} />}
    >
      {historyOmitted ? (
        <>
          <p>{t('shared.historyOmitted')}</p>
          <small>{t('shared.errorCode', { code: message })}</small>
        </>
      ) : (
        <p>{translateMessage(message)}</p>
      )}
    </NoticeBanner>
  );
}
