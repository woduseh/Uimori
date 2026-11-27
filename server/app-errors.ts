import {
  type AppErrorCode,
  type AppErrorParams,
  type AppErrorParamsArgument,
  appErrorTakesParams,
  type ErrorWire,
  isAppErrorCode,
} from '#contracts';
import { HttpError } from './request-validation.js';

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

export function storedModelRequired(error: unknown): string | undefined {
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
