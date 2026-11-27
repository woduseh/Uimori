import { AppError } from './app-errors.js';

const timeouts = new Set([
  'RISU_NATIVE_TIMEOUT',
  'RISU_NATIVE_CBS_TIMEOUT',
  'RISU_LUA_PROGRAM_TIMEOUT',
]);

export async function withRisuFailureCode<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Error && timeouts.has(error.message))
      throw new AppError(500, 'RISU_NATIVE_TIMEOUT');
    throw error;
  }
}
