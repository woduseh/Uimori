import {
  type AppErrorCode,
  type AppErrorParams,
  type AppErrorParamsArgument,
  type ErrorWire,
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
