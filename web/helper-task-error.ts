import { HELPER_COMPACTION_FAILURES } from '../core/helper.js';
import { t, translateMessage } from './i18n.js';
import { requestFileError } from './request-file-errors.js';
import { helperResponseRefused } from './RetryFailure.js';

export function helperTaskError(error: string | null | undefined): string {
  if (error && (HELPER_COMPACTION_FAILURES as readonly string[]).includes(error))
    return t(`errors.${error}`);
  if (error === 'HELPER_TASK_TIMEOUT') return t('errors.HELPER_TASK_TIMEOUT');
  if (helperResponseRefused(error)) return t('errors.HELPER_RESPONSE_REFUSED');
  return requestFileError(error) ?? translateMessage(error ?? '');
}
