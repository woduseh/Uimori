import { HttpError } from './request-validation.js';

let preparation: symbol | undefined;

export function checkImportPreparation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new HttpError(499, 'RISU_IMPORT_CANCELLED');
}

/** Risu and native archives share one process memory budget; busy requests never queue. */
export function acquireImportPreparation(signal?: AbortSignal): () => void {
  checkImportPreparation(signal);
  if (preparation) throw new HttpError(409, 'RISU_IMPORT_BUSY');
  const owner = Symbol('import preparation');
  preparation = owner;
  return () => {
    if (preparation === owner) preparation = undefined;
  };
}
