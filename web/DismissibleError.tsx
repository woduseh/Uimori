import { useI18n, t } from './i18n.js';
import { CloseIcon } from './ui-icons.js';
import { IconButton } from './IconButton.js';
import { NoticeBanner } from './NoticeBanner.js';
import { formatUiMessage, type UiMessage } from './ui-message.js';
import './dismissible-error.css';

export function DismissibleError({
  error,
  onDismiss,
}: {
  error: UiMessage | null | undefined;
  onDismiss: () => void;
}) {
  useI18n();
  if (!error) return null;
  return (
    <NoticeBanner
      tone="error"
      className="dismissible-error"
      actions={<IconButton label={t('shared.dismissError')} icon={CloseIcon} onClick={onDismiss} />}
    >
      <p>{formatUiMessage(error)}</p>
    </NoticeBanner>
  );
}
