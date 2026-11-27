import { AppError } from './app-errors.js';
import { HttpError } from './request-validation.js';

const timeouts = new Set([
  'RISU_NATIVE_TIMEOUT',
  'RISU_NATIVE_CBS_TIMEOUT',
  'RISU_LUA_PROGRAM_TIMEOUT',
]);

export async function withRisuFailureCode<T>(
  work: () => Promise<T>,
  route: 'presentation' | 'action'
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code =
      error instanceof Error && /^(RISU_[A-Z0-9_]{1,100})(?=:|$)/u.exec(error.message)?.[1];
    if (!code) throw error;
    if (timeouts.has(code))
      throw new AppError(route === 'action' ? 400 : 500, 'RISU_NATIVE_TIMEOUT');
    if (route === 'presentation') throw new HttpError(500, code);
    throw error;
  }
}
