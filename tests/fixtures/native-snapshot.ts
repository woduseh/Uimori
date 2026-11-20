import type { RunSnapshot } from '../../core/types.js';
import { prepareNativeRisuRun } from '../../server/risu-native-run.js';

export async function refreshNativeSnapshot(snapshot: RunSnapshot): Promise<void> {
  delete snapshot.nativeRisuExecution;
  delete snapshot.nativeRisuPresetProgram;
  delete snapshot.promptCompilation;
  Object.assign(snapshot, await prepareNativeRisuRun(snapshot));
}
