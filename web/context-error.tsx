import {
  asContextFailureCode,
  CONTEXT_JOB_INTERRUPTED,
  type ContextFailureCode,
  MODEL_REQUIRED_PATTERN,
  type ModelRequiredCode,
} from '../core/context-plan.js';
import { t, useI18n } from './i18n.js';
import { formatUiMessage, type MessageKey, type UiMessage, uiMessage } from './ui-message.js';

const promptUnsupported = 'settings.contextErrorPromptUnsupported';
const contextFailures = {
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
  CONTEXT_WINDOW_EXCEEDED: 'settings.contextErrorWindowExceeded',
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
  PROMPT_PREFILL_UNSUPPORTED: promptUnsupported,
  PROMPT_COMPLETED_ASSISTANT_AT_END_UNSUPPORTED: promptUnsupported,
  PROMPT_MID_SYSTEM_UNSUPPORTED: promptUnsupported,
  PROMPT_MID_SYSTEM_PLACEMENT_UNSUPPORTED: promptUnsupported,
  PROMPT_CACHE_UNSUPPORTED: promptUnsupported,
  PROMPT_CACHE_LIMIT: promptUnsupported,
  IMAGE_INPUT_UNSUPPORTED_MODEL: 'errors.IMAGE_INPUT_UNSUPPORTED_MODEL',
  IMAGE_INPUT_UNSUPPORTED_PROTOCOL: 'errors.IMAGE_INPUT_UNSUPPORTED_PROTOCOL',
  IMAGE_INPUT_UNAVAILABLE: 'errors.IMAGE_INPUT_UNAVAILABLE',
  IMAGE_REQUEST_TOO_LARGE: 'errors.IMAGE_REQUEST_TOO_LARGE',
  RISU_NATIVE_REQUEST_IMAGE_IDENTITY: 'errors.RISU_NATIVE_REQUEST_IMAGE_IDENTITY',
} as const satisfies Record<Exclude<ContextFailureCode, ModelRequiredCode>, MessageKey>;

const legacyContextFailures: Readonly<Record<string, ContextFailureCode>> = {
  'Server stopped; explicit retry required': CONTEXT_JOB_INTERRUPTED,
};

export function knownContextError(stored: string): UiMessage | undefined {
  const code = Object.hasOwn(legacyContextFailures, stored)
    ? legacyContextFailures[stored]
    : asContextFailureCode(stored);
  if (!code) return undefined;
  const role = MODEL_REQUIRED_PATTERN.exec(code)?.[1];
  return role
    ? uiMessage('errors.MODEL_REQUIRED', { role })
    : uiMessage(contextFailures[code as Exclude<ContextFailureCode, ModelRequiredCode>]);
}

const rawStyle = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as const;

export function ContextFailure({
  error,
  collapsed = false,
}: {
  error: string;
  collapsed?: boolean;
}) {
  useI18n();
  const known = knownContextError(error);
  if (known) return <span>{formatUiMessage(known)}</span>;
  const raw = <pre style={rawStyle}>{error}</pre>;
  return (
    <>
      <span>{t('settings.contextErrorFailed')}</span>
      {collapsed ? (
        raw
      ) : (
        <details>
          <summary>{t('settings.m303')}</summary>
          {raw}
        </details>
      )}
    </>
  );
}
