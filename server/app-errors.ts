import {
  type AppErrorCode,
  type AppErrorParams,
  type AppErrorParamsArgument,
  appErrorTakesParams,
  type ErrorWire,
  isAppErrorCode,
} from '#contracts';
import { AgentCollaborationError } from '../core/agent-collaboration.js';
import { ChatTranscriptError } from '../core/chat-transcript.js';
import { NativeTransferError } from '../core/native-transfer-validation.js';
import { RisuPromptError, risuPromptAppErrorCode } from '../core/risu-prompt.js';
import { ValidationError } from '../core/validation-error.js';
import { HttpError } from './request-validation.js';

export { HttpError };

export class AppError<C extends AppErrorCode = AppErrorCode> extends HttpError {
  readonly code: C;
  readonly params: AppErrorParams[C];
  constructor(statusCode: number, code: C, ...params: AppErrorParamsArgument<C>) {
    super(statusCode, code);
    this.code = code;
    this.params = params[0] as AppErrorParams[C];
  }
}

export type PlainAppErrorCode = {
  [C in AppErrorCode]: AppErrorParams[C] extends undefined ? C : never;
}[AppErrorCode];

export const isPlainAppErrorCode = (value: unknown): value is PlainAppErrorCode =>
  isAppErrorCode(value) && !appErrorTakesParams(value);

export function storedModelRequired(error: unknown): `MODEL_REQUIRED:${string}` | undefined {
  return error instanceof AppError && error.code === 'MODEL_REQUIRED'
    ? `MODEL_REQUIRED:${(error.params as AppErrorParams['MODEL_REQUIRED']).role}`
    : undefined;
}

export function appErrorFrom(statusCode: number, code: AppErrorCode, params?: unknown): AppError {
  const create = AppError as unknown as new (
    statusCode: number,
    code: AppErrorCode,
    params?: unknown
  ) => AppError;
  return new create(statusCode, code, params);
}

export function validationAppError(error: ValidationError): AppError {
  const appError = appErrorFrom(error.statusCode, error.code, error.params);
  appError.message = `${error.code}: ${error.message}`;
  return appError;
}

const transcriptErrorCodes = [
  'CHAT_TRANSCRIPT_UNSUPPORTED_VERSION',
  'CHAT_TRANSCRIPT_INVALID_REQUEST',
  'CHAT_TRANSCRIPT_INVALID_TEXT',
  'CHAT_TRANSCRIPT_INVALID_TRANSLATION',
] as const;

function coreErrorCode(error: unknown): PlainAppErrorCode | undefined {
  if (error instanceof NativeTransferError)
    return error.code === 'NATIVE_TRANSFER_FORMAT' ||
      error.code === 'NATIVE_TRANSFER_MODULE_BINDINGS'
      ? error.code
      : 'NATIVE_TRANSFER_FILE_INVALID';
  if (error instanceof ChatTranscriptError)
    return transcriptErrorCodes.find((code) => code === error.message) ?? 'CHAT_TRANSCRIPT_INVALID';
  if (error instanceof RisuPromptError) return risuPromptAppErrorCode(error);
  if (error instanceof AgentCollaborationError) return 'AGENT_COLLABORATION_INVALID';
  return undefined;
}

export function asAppError<T>(error: T): T | AppError {
  if (error instanceof ValidationError) return validationAppError(error);
  const code = coreErrorCode(error);
  if (!code) return error;
  const appError = new AppError(400, code);
  const detail = (error as Error).message;
  if (detail !== code) appError.message = `${code}: ${detail}`;
  return appError;
}

export function assertRevision(actual: number, expected: number): void {
  if (actual !== expected) throw new AppError(409, 'REVISION_CONFLICT');
}

export class HelperToolError extends HttpError {
  readonly code: string;
  constructor(statusCode: number, code: string, detail?: string) {
    super(statusCode, detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

export function errorWire(error: unknown, legacyMessage: string): ErrorWire {
  if (!(error instanceof AppError)) return { error: legacyMessage };
  return (
    error.params === undefined ? { code: error.code } : { code: error.code, params: error.params }
  ) as ErrorWire;
}
