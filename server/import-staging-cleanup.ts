import type { Store } from './store.js';
import { prunePreparedArchives } from './native-transfer-archive.js';
import { prunePreparedRisuImports } from './risu-import-prepared.js';

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
        process.stderr.write('IMPORT_STAGING_CLEANUP_DEFERRED\n');
      }
    }
  };
  cleanup();
  const timer = setInterval(cleanup, 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
