import type { RunSnapshot } from '../core/types.js';
import { nativeRisuPackages } from './risu-native-context.js';
import { prepareNativeRisuRun } from './risu-native-run.js';

/** Pure input projection for an independent artifact or manual context operation.
 * CBS/regex writes remain in this copy; Lua/V2 callbacks, persistent VMs and paid hosts are absent.
 */
export async function prepareNativeRisuReadOnly(
  snapshot: RunSnapshot,
  purpose: 'artifact' | 'context'
): Promise<RunSnapshot> {
  if (
    !nativeRisuPackages(snapshot).length &&
    !snapshot.profile?.promptPresets?.main?.program.nativeRisuPreset
  )
    return snapshot;
  const input = structuredClone(snapshot);
  // A revised artifact has a new request. Its predecessor's evaluated prompt is historical evidence.
  delete input.nativeRisuExecution;
  delete input.nativeRisuPresetProgram;
  delete input.promptCompilation;
  delete input.promptInputTransforms;
  const prepared = await prepareNativeRisuRun(input, { preview: true });
  prepared.nativeRisuExecution!.issues = prepared.nativeRisuExecution!.issues.map((issue) =>
    issue === 'RISU_NATIVE_PREVIEW_CALLBACKS_DEFERRED'
      ? `RISU_NATIVE_${purpose.toUpperCase()}_CALLBACKS_DEFERRED`
      : issue
  );
  return prepared;
}
