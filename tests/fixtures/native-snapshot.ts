import type { RunSnapshot } from '../../core/types.js';
import { prepareNativeRisuRun } from '../../server/risu-native-run.js';

/** Rebuild actual native execution after a fixture deliberately changes its authored inputs. */
export async function refreshNativeSnapshot(snapshot: RunSnapshot): Promise<void> {
  delete snapshot.nativeRisuExecution;
  delete snapshot.nativeRisuPresetProgram;
  delete snapshot.promptCompilation;
  Object.assign(snapshot, await prepareNativeRisuRun(snapshot));
}
