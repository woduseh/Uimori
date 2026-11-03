import { HttpError } from './request-validation.js';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

let preparation: symbol | undefined;

/** Automatic deletion must not follow a staging root or parent outside the actual DB directory. */
export function ownedImportStagingRoot(dbPath: string, root: string): boolean {
  try {
    const owner = dirname(realpathSync(dbPath));
    const within = relative(owner, resolve(root));
    if (!within || isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`))
      return false;
    let path = owner;
    for (const segment of within.split(sep)) {
      path = join(path, segment);
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
      const realWithin = relative(owner, realpathSync(path));
      if (
        !realWithin ||
        isAbsolute(realWithin) ||
        realWithin === '..' ||
        realWithin.startsWith(`..${sep}`)
      )
        return false;
    }
    return true;
  } catch {
    // A missing or inaccessible root is never a safe automatic deletion target.
    return false;
  }
}

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
