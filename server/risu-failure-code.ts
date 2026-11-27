import { AppError } from './app-errors.js';
import { HttpError } from './request-validation.js';

const timeouts = new Set([
  'RISU_NATIVE_TIMEOUT',
  'RISU_NATIVE_CBS_TIMEOUT',
  'RISU_LUA_PROGRAM_TIMEOUT',
]);

function failureStatus(error: Error): number {
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? status : 500;
}

export async function withRisuFailureCode<T>(
  work: () => Promise<T>,
  route: 'presentation' | 'action'
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (timeouts.has(error.message))
      throw new AppError(route === 'action' ? failureStatus(error) : 500, 'RISU_NATIVE_TIMEOUT');
    if (route === 'presentation' && /^RISU_[A-Z0-9_]{1,100}$/u.test(error.message))
      throw new HttpError(500, error.message);
    throw error;
  }
}
