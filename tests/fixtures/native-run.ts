import type { Run } from '../../server/store.js';
import type { Store } from '../../server/store.js';
import { prepareNativeRisuRun } from '../../server/risu-native-run.js';
import { compileSnapshotPrompt } from '../../server/prompt-snapshot.js';

/** Exercise native preparation before synthetic store-only completions/candidate replay. */
export async function prepareNativeFixtureRun(store: Store, run: Run): Promise<Run> {
  const snapshot = compileSnapshotPrompt(await prepareNativeRisuRun(run.snapshot));
  store.db.prepare('UPDATE runs SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot), run.id);
  return store.run(run.id);
}
