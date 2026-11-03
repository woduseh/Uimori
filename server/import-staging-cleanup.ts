import type { Store } from './store.js';
import { prunePreparedArchives } from './native-transfer-archive.js';
import { prunePreparedRisuImports } from './risu-import-prepared.js';

/** Expired previews are inaccessible after one day; remove their files without another import. */
export function startImportStagingCleanup(
  store: Store,
  canRun: () => boolean = () => true
): () => void {
  const cleanup = () => {
    try {
      if (!canRun()) return;
    } catch {
      process.stderr.write('IMPORT_STAGING_CLEANUP_DEFERRED\n');
      return;
    }
    for (const prune of [
      () => prunePreparedArchives(store),
      () => prunePreparedRisuImports(store.path),
    ]) {
      try {
        prune();
      } catch {
        // A failure in one staging root must not block startup or the other root.
        process.stderr.write('IMPORT_STAGING_CLEANUP_DEFERRED\n');
      }
    }
  };
  cleanup();
  const timer = setInterval(cleanup, 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
