import { t } from './i18n.js';

type AuxiliaryErrorDiagnostic = {
  code: string | null;
  message: string;
  action: string;
};

// Only exact local codes may reach the UI. Never echo remote text or an unknown code.
const diagnostics = new Map<string, Omit<AuxiliaryErrorDiagnostic, 'code'>>();
const define = (codes: string[], message: string, action: string) => {
  for (const code of codes) diagnostics.set(code, { message, action });
};

define(
  ['PROMPT_UNKNOWN_SLOT'],
  'errors.auxiliary.PROMPT_UNKNOWN_SLOT.message',
  'errors.auxiliary.PROMPT_UNKNOWN_SLOT.action'
);

define(
  ['JEV_CREDENTIAL_REQUIRED', 'JEV_HTTP_401', 'JEV_HTTP_403'],
  'errors.auxiliary.JEV_CREDENTIAL_REQUIRED.message',
  'errors.auxiliary.JEV_CREDENTIAL_REQUIRED.action'
);
define(
  ['JEV_INPUT_BUDGET'],
  'errors.auxiliary.JEV_INPUT_BUDGET.message',
  'errors.auxiliary.JEV_INPUT_BUDGET.action'
);
define(
  ['JEV_RESPONSE_INVALID'],
  'errors.auxiliary.JEV_RESPONSE_INVALID.message',
  'errors.auxiliary.JEV_RESPONSE_INVALID.action'
);
define(
  ['JEV_EXECUTION_FAILED', 'JEV_TIMEOUT', 'JEV_HTTP_429'],
  'errors.auxiliary.JEV_EXECUTION_FAILED.message',
  'errors.auxiliary.JEV_EXECUTION_FAILED.action'
);

define(
  [
    'AUXILIARY_PROVIDER_HTTP_401',
    'AUXILIARY_PROVIDER_HTTP_403',
    'AUXILIARY_PROVIDER_CREDENTIAL_UNAVAILABLE',
    'CONNECTION_NOT_AUTHORIZED',
  ],
  'errors.auxiliary.AUXILIARY_PROVIDER_HTTP_401.message',
  'errors.auxiliary.AUXILIARY_PROVIDER_HTTP_401.action'
);
define(
  ['AUXILIARY_PROVIDER_HTTP_400', 'AUXILIARY_PROVIDER_HTTP_404', 'AUXILIARY_PROVIDER_HTTP_422'],
  'errors.auxiliary.AUXILIARY_PROVIDER_HTTP_400.message',
  'errors.auxiliary.AUXILIARY_PROVIDER_HTTP_400.action'
);
define(
  ['AUXILIARY_PROVIDER_HTTP_429'],
  'errors.auxiliary.AUXILIARY_PROVIDER_HTTP_429.message',
  'errors.auxiliary.AUXILIARY_PROVIDER_HTTP_429.action'
);
define(
  [
    'AUXILIARY_PROVIDER_HTTP_500',
    'AUXILIARY_PROVIDER_HTTP_502',
    'AUXILIARY_PROVIDER_HTTP_503',
    'AUXILIARY_PROVIDER_HTTP_504',
  ],
  'errors.auxiliary.AUXILIARY_PROVIDER_HTTP_500.message',
  'errors.auxiliary.AUXILIARY_PROVIDER_HTTP_500.action'
);
define(
  [
    'AUXILIARY_PROVIDER_TIMEOUT',
    'AUXILIARY_PROVIDER_UND_ERR_HEADERS_TIMEOUT',
    'AUXILIARY_PROVIDER_UND_ERR_BODY_TIMEOUT',
    'AUXILIARY_PROVIDER_UND_ERR_CONNECT_TIMEOUT',
  ],
  'errors.auxiliary.AUXILIARY_PROVIDER_TIMEOUT.message',
  'errors.auxiliary.AUXILIARY_PROVIDER_TIMEOUT.action'
);
define(
  ['AUXILIARY_PROVIDER_INPUT_CONTEXT_LIMIT_EXCEEDED', 'AUXILIARY_PROVIDER_CONTEXT_WINDOW_EXCEEDED'],
  'errors.auxiliary.AUXILIARY_PROVIDER_INPUT_CONTEXT_LIMIT_EXCEEDED.message',
  'errors.auxiliary.AUXILIARY_PROVIDER_INPUT_CONTEXT_LIMIT_EXCEEDED.action'
);
define(
  ['AUXILIARY_PROVIDER_PARTIAL'],
  'errors.auxiliary.AUXILIARY_PROVIDER_PARTIAL.message',
  'errors.auxiliary.AUXILIARY_PROVIDER_PARTIAL.action'
);
define(
  [
    'AUXILIARY_PROVIDER_TRANSPORT_ERROR',
    'AUXILIARY_PROVIDER_UND_ERR_SOCKET',
    'AUXILIARY_PROVIDER_UNEXPECTED_EOF',
  ],
  'errors.auxiliary.AUXILIARY_PROVIDER_TRANSPORT_ERROR.message',
  'errors.auxiliary.AUXILIARY_PROVIDER_TRANSPORT_ERROR.action'
);
define(
  ['TRANSLATION_REFUSAL_CHECK_FAILED'],
  'errors.auxiliary.TRANSLATION_REFUSAL_CHECK_FAILED.message',
  'errors.auxiliary.TRANSLATION_REFUSAL_CHECK_FAILED.action'
);
define(
  ['TRANSLATION_REFUSAL_UNCERTAIN'],
  'errors.auxiliary.TRANSLATION_REFUSAL_UNCERTAIN.message',
  'errors.auxiliary.TRANSLATION_REFUSAL_UNCERTAIN.action'
);
define(
  ['TRANSLATION_REFUSAL_RETRIES_EXHAUSTED'],
  'errors.auxiliary.TRANSLATION_REFUSAL_RETRIES_EXHAUSTED.message',
  'errors.auxiliary.TRANSLATION_REFUSAL_RETRIES_EXHAUSTED.action'
);
define(
  ['AUXILIARY_PROVIDER_REFUSED'],
  'errors.auxiliary.AUXILIARY_PROVIDER_REFUSED.message',
  'errors.auxiliary.AUXILIARY_PROVIDER_REFUSED.action'
);
define(
  [
    'AUXILIARY_PROVIDER_EMPTY_COMPLETION',
    'AUXILIARY_PROVIDER_EMPTY_RESPONSE',
    'AUXILIARY_PROVIDER_EMPTY',
  ],
  'errors.auxiliary.AUXILIARY_PROVIDER_EMPTY_COMPLETION.message',
  'errors.auxiliary.AUXILIARY_PROVIDER_EMPTY_COMPLETION.action'
);
define(
  ['OUTPUT_SCHEMA_INVALID'],
  'errors.auxiliary.OUTPUT_SCHEMA_INVALID.message',
  'errors.auxiliary.OUTPUT_SCHEMA_INVALID.action'
);
define(
  ['EVALUATION_SUBMISSION_REQUIRED'],
  'errors.auxiliary.EVALUATION_SUBMISSION_REQUIRED.message',
  'errors.auxiliary.EVALUATION_SUBMISSION_REQUIRED.action'
);
define(
  ['SOURCE_DEPENDENCY_MISMATCH'],
  'errors.auxiliary.SOURCE_DEPENDENCY_MISMATCH.message',
  'errors.auxiliary.SOURCE_DEPENDENCY_MISMATCH.action'
);
define(
  ['AUXILIARY_CALL_BUDGET_EXHAUSTED'],
  'errors.auxiliary.AUXILIARY_CALL_BUDGET_EXHAUSTED.message',
  'errors.auxiliary.AUXILIARY_CALL_BUDGET_EXHAUSTED.action'
);
define(
  ['TOOL_CONTEXT_BUDGET_EXHAUSTED'],
  'errors.auxiliary.TOOL_CONTEXT_BUDGET_EXHAUSTED.message',
  'errors.auxiliary.TOOL_CONTEXT_BUDGET_EXHAUSTED.action'
);
define(
  ['TOOL_CORRECTION_EXHAUSTED'],
  'errors.auxiliary.TOOL_CORRECTION_EXHAUSTED.message',
  'errors.auxiliary.TOOL_CORRECTION_EXHAUSTED.action'
);
define(
  ['AUXILIARY_CANCELLED'],
  'errors.auxiliary.AUXILIARY_CANCELLED.message',
  'errors.auxiliary.AUXILIARY_CANCELLED.action'
);
define(
  ['AUXILIARY_INCOMPLETE', 'AUXILIARY_EXECUTION_FAILED'],
  'errors.auxiliary.AUXILIARY_INCOMPLETE.message',
  'errors.auxiliary.AUXILIARY_INCOMPLETE.action'
);

export function auxiliaryErrorDiagnostic(error: unknown): AuxiliaryErrorDiagnostic {
  const role =
    typeof error === 'string' ? /^MODEL_REQUIRED:(main|translation)$/.exec(error)?.[1] : undefined;
  if (role)
    return {
      code: error as string,
      message: t('errors.auxiliaryModelRequired', { role }),
      action: t('errors.auxiliaryModelAction', { role }),
    };
  const diagnostic = typeof error === 'string' ? diagnostics.get(error) : undefined;
  if (diagnostic)
    return { code: error as string, message: t(diagnostic.message), action: t(diagnostic.action) };
  return {
    code: null,
    message: t('errors.auxiliary.AUXILIARY_INCOMPLETE.message'),
    action: t('errors.auxiliary.AUXILIARY_INCOMPLETE.action'),
  };
}

/** Complete message for surfaces that show diagnosis and recovery together. */
export function auxiliaryErrorMessage(error: unknown): string {
  const role =
    typeof error === 'string' ? /^MODEL_REQUIRED:(main|translation)$/.exec(error)?.[1] : undefined;
  if (role) return t('errors.auxiliaryModelDetails', { role });
  const diagnostic = typeof error === 'string' ? diagnostics.get(error) : undefined;
  return t(
    diagnostic
      ? diagnostic.message.replace(/\.message$/u, '.details')
      : 'errors.auxiliary.AUXILIARY_INCOMPLETE.details'
  );
}
