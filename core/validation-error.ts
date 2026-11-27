import type { AppErrorCode, AppErrorParams, AppErrorParamsArgument } from '#contracts';

export class ValidationError<C extends AppErrorCode = AppErrorCode> extends Error {
  readonly statusCode: 400 | 409;
  readonly code: C;
  readonly params: AppErrorParams[C];
  constructor(statusCode: 400 | 409, code: C, text: string, ...params: AppErrorParamsArgument<C>) {
    super(text);
    this.statusCode = statusCode;
    this.code = code;
    this.params = params[0] as AppErrorParams[C];
    this.name = 'ValidationError';
  }
}
