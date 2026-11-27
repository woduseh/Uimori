import { HELPER_COMPACTION_FAILURES } from '../core/helper.js';
import { requestFileError } from './request-file-errors.js';
import { helperResponseRefused } from './RetryFailure.js';
import { uiMessage, uiText, type MessageKey, type UiMessage } from './ui-message.js';

export function helperTaskError(error: string): UiMessage {
  if ((HELPER_COMPACTION_FAILURES as readonly string[]).includes(error))
    return uiMessage(`errors.${error}` as MessageKey);
  if (error === 'HELPER_TASK_TIMEOUT') return uiMessage('errors.HELPER_TASK_TIMEOUT');
  if (helperResponseRefused(error)) return uiMessage('errors.HELPER_RESPONSE_REFUSED');
  return requestFileError(error) ?? uiText(error);
}
