import { t, useI18n } from './i18n.js';
import { ActionMenu } from './ActionMenu.js';
import { HistoryIcon, IssueIcon } from './ui-icons.js';
import './retry-failure.css';
import { mainJudgmentError } from './main-judgment-error.js';

export function RetryFailure({
  status,
  error,
  disabled,
  onRetry,
  onRejudge,
  onSettings,
  onDetails,
  onHistory,
}: {
  status: string;
  error?: string | null;
  disabled?: boolean;
  onRetry?: () => void;
  onRejudge?: () => void;
  onSettings?: () => void;
  onDetails: () => void;
  onHistory: () => void;
}) {
  useI18n();
  const settings =
    /PROMPT_|UNSUPPORTED_OPTIONS|HTTP_40[0134]|JEV_|MAIN_RESPONSE_REFUSED|MAIN_JUDGMENT_CALL_BUDGET|EVALUATION_SUBMISSION_REQUIRED|IMAGE_INPUT_UNSUPPORTED/u.test(
      error ?? ''
    );
  const message =
    status === 'cancelled'
      ? t('shared.cancelled')
      : status === 'interrupted'
        ? t('shared.interrupted')
        : status === 'refused'
          ? t('shared.refused')
          : status === 'partial'
            ? t('shared.partial')
            : error?.includes('PROMPT_UNKNOWN_SLOT')
              ? t('shared.unknownSlot')
              : error?.includes('UNSUPPORTED_OPTIONS')
                ? t('shared.unsupportedOptions')
                : error?.includes('429')
                  ? t('shared.rateLimit')
                  : t('shared.responseFailure');
  return (
    <div
      className="turn-failure chat-retry-failure"
      role="group"
      aria-label={t('shared.failedRequest')}
    >
      <p>{onRejudge ? t('shared.rejudgeDescription') : (mainJudgmentError(error) ?? message)}</p>
      <div className="turn-failure-actions">
        {onRejudge && (
          <button
            type="button"
            className="secondary"
            disabled={disabled}
            title={t('shared.rejudgeHelp')}
            onClick={onRejudge}
          >
            {t('shared.rejudge')}
          </button>
        )}
        {onRetry && (
          <button
            type="button"
            className="secondary"
            disabled={disabled}
            title={t('shared.retryHelp')}
            onClick={onRetry}
          >
            {t('shared.retry')}
          </button>
        )}
        {settings && onSettings && (
          <button type="button" className="secondary" onClick={onSettings}>
            {t('shared.checkSettings')}
          </button>
        )}
        <ActionMenu label={t('shared.failedMore')}>
          <button type="button" onClick={onDetails}>
            <IssueIcon size={18} aria-hidden="true" />
            {t('shared.errorDetails')}
          </button>
          <button type="button" onClick={onHistory}>
            <HistoryIcon size={18} aria-hidden="true" />
            {t('shared.history')}
          </button>
        </ActionMenu>
      </div>
    </div>
  );
}
