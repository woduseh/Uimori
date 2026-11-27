import {
  CONTEXT_JOB_INTERRUPTED,
  type ContextErrorCode,
  isContextErrorCode,
  MODEL_REQUIRED_PATTERN,
} from '../core/context-plan.js';
import { type MessageKey, type UiMessage, uiMessage, uiText } from './ui-message.js';

const contextErrors = {
  CANCELLED: 'settings.contextJobCancelled',
  CONTEXT_CANCELLED: 'settings.contextJobCancelled',
  CONTEXT_JOB_SCENE_DELETED: 'settings.contextJobSceneDeleted',
  CONTEXT_JOB_INTERRUPTED: 'settings.contextJobInterrupted',
  CONNECTION_NOT_AUTHORIZED: 'settings.contextErrorConnection',
  CONTEXT_COMPACTION_TIMEOUT: 'settings.contextErrorTimeout',
  CONTEXT_COMPACTION_REFUSED: 'settings.contextErrorRefused',
  CONTEXT_COMPACTION_EMPTY: 'settings.contextErrorUnusable',
  CONTEXT_COMPACTION_EOF: 'settings.contextErrorUnusable',
  CONTEXT_COMPACTION_PARTIAL: 'settings.contextErrorUnusable',
  CONTEXT_COMPACTION_UNEXPECTED_TOOLS: 'settings.contextErrorUnusable',
  CONTEXT_COMPACTION_PROVIDER_ERROR: 'settings.contextErrorProvider',
  CONTEXT_COMPACTION_CALL_LIMIT: 'settings.contextErrorCallLimit',
  CONTEXT_TOOL_COMPACTION_CALL_LIMIT: 'settings.contextErrorCallLimit',
  CONTEXT_FIXED_INPUT_TOO_LARGE: 'errors.CONTEXT_FIXED_INPUT_TOO_LARGE',
  CONTEXT_TOOL_COMPACTION_FIXED_INPUT_TOO_LARGE: 'errors.CONTEXT_FIXED_INPUT_TOO_LARGE',
  CONTEXT_SUMMARY_TARGET_TOO_SMALL: 'settings.contextErrorTargetTooSmall',
  CONTEXT_SUMMARY_TOO_LARGE: 'settings.contextErrorSummaryTooLarge',
  CONTEXT_SUMMARY_MODEL_DISABLED: 'settings.contextErrorModelDisabled',
  CONTEXT_DEPENDENCIES_CHANGED: 'settings.contextErrorInputsChanged',
  CONTEXT_SOURCE_HASH_MISMATCH: 'settings.contextErrorInputsChanged',
  CONTEXT_SOURCE_MISMATCH: 'settings.contextErrorInputsChanged',
  CONTEXT_INPUT_MISSING: 'settings.contextErrorInputsChanged',
  CONTEXT_JOB_NOT_RUNNING: 'settings.contextErrorInputsChanged',
  CONTEXT_TOOL_RESULTS_TOO_LARGE: 'settings.contextErrorToolResultsTooLarge',
  CONTEXT_TOOL_COMPACTION_NO_PROGRESS: 'settings.contextErrorToolResultsTooLarge',
  CONTEXT_ATTEMPT_START_FAILED: 'settings.contextErrorFailed',
  CONTEXT_ATTEMPT_FINISH_FAILED: 'settings.contextErrorFailed',
  CONTEXT_ATTEMPT_MISSING: 'settings.contextErrorFailed',
  CONTEXT_BUDGET_MISMATCH: 'settings.contextErrorFailed',
  CONTEXT_CHECKPOINT_INVALID: 'settings.contextErrorFailed',
  CONTEXT_COMPACTION_FAILED: 'settings.contextErrorFailed',
  CONTEXT_LOGICAL_PAIR_MISSING: 'settings.contextErrorFailed',
  CONTEXT_PLAN_REQUIRED: 'settings.contextErrorFailed',
  CONTEXT_PROGRESS_SAVE_FAILED: 'settings.contextErrorFailed',
  CONTEXT_TOOL_COMPACTION_EOF: 'settings.contextErrorFailed',
  CONTEXT_TOOL_COMPACTION_FAILED: 'settings.contextErrorFailed',
} as const satisfies Record<ContextErrorCode, MessageKey>;

const legacyContextErrors: Readonly<Record<string, ContextErrorCode>> = {
  'Server stopped; explicit retry required': CONTEXT_JOB_INTERRUPTED,
};

export function knownContextError(code: string): UiMessage | undefined {
  const role = MODEL_REQUIRED_PATTERN.exec(code)?.[1];
  if (role) return uiMessage('errors.MODEL_REQUIRED', { role });
  const current = Object.hasOwn(legacyContextErrors, code) ? legacyContextErrors[code] : code;
  return isContextErrorCode(current) ? uiMessage(contextErrors[current]) : undefined;
}

export function contextErrorMessage(code: string): UiMessage {
  return knownContextError(code) ?? uiText(code);
}
