import { ApiError } from './api.js';
import { errorDescriptor } from './api-errors.js';
import type { MessageKey } from './ui-message.js';

export type CaughtErrorState = { message: string; code: string | null };

export function caughtErrorState(
  cause: unknown,
  fallback: MessageKey = 'errors.unexpected'
): CaughtErrorState {
  return {
    message: errorDescriptor(cause, fallback),
    code: cause instanceof ApiError ? cause.code : null,
  };
}
