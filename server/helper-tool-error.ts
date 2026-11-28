import { AppError, asAppError, HelperToolError } from './app-errors.js';
import { HelperResourceBatchError } from './helper-resource-batch.js';
import { HelperResourcePatchError } from './helper-resource-patch-error.js';
import { HelperShellExecutionError } from './helper-shell.js';
import { HttpError } from './request-validation.js';

export function helperToolError(thrown: unknown, readOnly: boolean, toolName: string) {
  const error = asAppError(thrown);
  const shell = error instanceof HelperShellExecutionError ? error : undefined;
  const batch = error instanceof HelperResourceBatchError ? error : undefined;
  const cause = asAppError(batch?.cause ?? error);
  const patch = cause instanceof HelperResourcePatchError ? cause : undefined;
  const message = error instanceof Error ? error.message : 'HELPER_TOOL_FAILED';
  const status = error instanceof HttpError ? error.statusCode : undefined;
  // SQLite uses ERR_SQLITE_ERROR for both user mistakes and authorization failures.
  const unknownSqlColumn =
    readOnly && toolName === 'db.query' && /^no such column: [^\r\n]+$/u.test(message);
  const invalidSql =
    readOnly &&
    toolName === 'db.query' &&
    /^(no such (table|function): [^\r\n]+|near "[^\r\n]*": syntax error|incomplete input)$/u.test(
      message
    );
  const code = unknownSqlColumn
    ? 'DATA_SQL_UNKNOWN_COLUMN'
    : invalidSql
      ? 'DATA_SQL_INVALID'
      : patch
        ? `PATCH_${patch.details.reason.toUpperCase()}`
        : cause instanceof HelperToolError || cause instanceof AppError
          ? cause.code
          : (/^[A-Z][A-Z_]+/u.exec(message)?.[0] ??
            (status === 409
              ? 'REVISION_CONFLICT'
              : status === 400
                ? 'INVALID_ARGUMENTS'
                : 'HELPER_TOOL_FAILED'));
  const stopped =
    status === 401 ||
    status === 403 ||
    /^(CURRENT_HELPER_TASK|HELPER_EFFECTS_ALREADY_COMMITTED|TASK_NOT_|MODEL_CALL_BUDGET)/u.test(
      code
    );
  const invalidArguments =
    !['DATA_RESULT_INVALID', 'DATA_INPUT_INVALID'].includes(code) &&
    /^(DATA_[A-Z_]+_(INVALID|REQUIRED)|DATA_UNKNOWN_ARGUMENT|DATA_EMPTY_PATTERN|DATA_USE_CHATS_SCOPE|SCENE_REGEX_INVALID_[A-Z_]+|SCENE_SEARCH_GUARDS_REQUIRED)$/u.test(
      code
    );
  const wrongProfileScope = code === 'ILLUSTRATION_PROFILE_CHAT_ONLY';
  const needsChat = code === 'CHAT_SCOPE_REQUIRED';
  const retryMode = needsChat
    ? 'correct_arguments'
    : stopped
      ? 'never'
      : wrongProfileScope
        ? 'switch_tool'
        : unknownSqlColumn || patch || invalidArguments
          ? 'correct_arguments'
          : status === 409 || status === 404
            ? 'refresh_then_retry'
            : status === 400
              ? 'correct_arguments'
              : status === 413 || code === 'DATA_QUERY_TIMEOUT'
                ? 'narrow_read'
                : readOnly
                  ? 'never'
                  : 'inspect_outcome';
  return {
    error: message,
    code,
    ...(cause instanceof AppError && cause.params !== undefined ? { params: cause.params } : {}),
    recoverable: !['never', 'inspect_outcome'].includes(retryMode),
    retryMode,
    outcome: retryMode === 'inspect_outcome' ? 'unknown' : 'unchanged',
    ...(shell ? { applied: shell.applied } : {}),
    ...(patch || batch
      ? {
          details: {
            ...(batch ? { itemIndex: batch.itemIndex, kind: batch.kind, id: batch.id } : {}),
            ...patch?.details,
          },
        }
      : {}),
    nextAction: needsChat
      ? {
          tool: 'chat.list',
          guidance:
            'Choose the target chatId and pass it to the original operation. Chat-only tools cannot use a library default scope.',
        }
      : wrongProfileScope
        ? {
            tool: 'resource.read',
            guidance:
              'Find the shared bot/persona content ID, read its revision and source.appearanceProfilesPath, then use resource.patch with the full {id,name,appearance,referenceImageId?} array. Do not search for a chat.',
          }
        : unknownSqlColumn
          ? 'Correct the SQL query using the columns listed in the error. Do not repeat the unchanged query.'
          : retryMode === 'refresh_then_retry'
            ? 'Read the affected source or task state again in the same scope before changing the request.'
            : retryMode === 'correct_arguments'
              ? 'Correct the arguments using the discovered tool schema; do not repeat the same request.'
              : retryMode === 'narrow_read'
                ? 'Read fewer items or a smaller range in the same scope.'
                : retryMode === 'inspect_outcome'
                  ? 'Inspect the task and committed effects before another write. Do not automatically replay it.'
                  : 'Stop this operation and explain the condition; do not repeat it unchanged.',
  };
}
