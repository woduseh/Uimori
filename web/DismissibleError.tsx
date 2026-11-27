import { useI18n, t } from './i18n.js';
import { CloseIcon } from './ui-icons.js';
import { IconButton } from './IconButton.js';
import { NoticeBanner } from './NoticeBanner.js';
import { displayMessage, type DisplayMessage } from './ui-message.js';
import './dismissible-error.css';

export function DismissibleError({
  error,
  onDismiss,
}: {
  error: DisplayMessage | null | undefined;
  onDismiss: () => void;
}) {
  useI18n();
  if (!error) return null;
  const historyOmitted = error === 'PROMPT_HISTORY_OMITTED';
  return (
    <NoticeBanner
      tone="error"
      className="dismissible-error"
      actions={<IconButton label={t('shared.dismissError')} icon={CloseIcon} onClick={onDismiss} />}
    >
      {historyOmitted ? (
        <>
          <p>{t('shared.historyOmitted')}</p>
          <small>{t('shared.errorCode', { code: error })}</small>
        </>
      ) : (
        <p>{displayMessage(error)}</p>
      )}
    </NoticeBanner>
  );
}
