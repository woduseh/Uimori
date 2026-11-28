import { HttpError } from './request-validation.js';
import { AppError } from './app-errors.js';

let preparation: symbol | undefined;

export function checkImportPreparation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new HttpError(499, 'RISU_IMPORT_CANCELLED');
}

export function acquireImportPreparation(signal?: AbortSignal): () => void {
  checkImportPreparation(signal);
  if (preparation) throw new AppError(409, 'RISU_IMPORT_BUSY');
  const owner = Symbol('import preparation');
  preparation = owner;
  return () => {
    if (preparation === owner) preparation = undefined;
  };
}
