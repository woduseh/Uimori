import { t, useI18n } from './i18n.js';
import { ActionMenu } from './ActionMenu.js';
import { HistoryIcon, IssueIcon } from './ui-icons.js';
import './retry-failure.css';
import { mainJudgmentError } from './main-judgment-error.js';

export const helperResponseRefused = (error?: string | null) =>
  /^(HELPER_RESPONSE_REFUSED(:|$)|SAFETY$|PROHIBITED_CONTENT$|BLOCKLIST$|SPII$|RECITATION$|ANTHROPIC_REFUSAL$)/u.test(
    error ?? ''
  );

export function RetryFailure({
  status,
  error,
  disabled,
  onResume,
  onRetry,
  onRejudge,
  onSettings,
  onDetails,
  onHistory,
}: {
  status: string;
  error?: string | null;
  disabled?: boolean;
  onResume?: () => void;
  onRetry?: () => void;
  onRejudge?: () => void;
  onSettings?: () => void;
  onDetails: () => void;
  onHistory: () => void;
}) {
  useI18n();
  const settings =
    /PROMPT_|UNSUPPORTED_OPTIONS|HTTP_40[0134]|JEV_|JUDGMENT_|MAIN_RESPONSE_REFUSED|MAIN_JUDGMENT_CALL_BUDGET|EVALUATION_SUBMISSION_REQUIRED|IMAGE_INPUT_UNSUPPORTED|HELPER_TASK_TIMEOUT/u.test(
      error ?? ''
    );
  const storyUiError =
    error === 'STORY_UI_STALE_SOURCE' ? t('storyUi.errorStaleSource') : undefined;
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
                  : helperResponseRefused(error)
                    ? t('errors.HELPER_RESPONSE_REFUSED')
                    : error === 'HELPER_TASK_TIMEOUT'
                      ? t('errors.HELPER_TASK_TIMEOUT')
                      : error?.includes('TIMEOUT')
                        ? t('shared.timeoutFailure')
                        : error?.includes('TRANSPORT_ERROR')
                          ? t('shared.connectionFailure')
                          : /HTTP_40[13]/u.test(error ?? '')
                            ? t('shared.authFailure')
                            : /HTTP_5\d\d/u.test(error ?? '')
                              ? t('shared.providerFailure')
                              : t('shared.responseFailure');
  return (
    <div
      className="turn-failure chat-retry-failure"
      role="group"
      aria-label={t('shared.failedRequest')}
    >
      <p>
        {onRejudge
          ? t('shared.rejudgeDescription')
          : (storyUiError ?? mainJudgmentError(error) ?? message)}
      </p>
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
        {onResume && (
          <button
            type="button"
            className="secondary"
            disabled={disabled}
            title={t('shared.resumeHelp')}
            onClick={onResume}
          >
            {t('shared.resume')}
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
