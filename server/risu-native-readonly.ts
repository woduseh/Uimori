import type { RunSnapshot } from '../core/types.js';
import { compiledPackages } from '../core/package-context.js';
import { normalizeRisuContentSource } from '../core/risu-native.js';
import { stripDeprecatedRisuPresetFields } from '../core/risu-deprecated-fields.js';
import { isDeepStrictEqual } from 'node:util';
import { nativeRisuPackages } from './risu-native-context.js';
import { prepareNativeRisuRun } from './risu-native-run.js';
import { projectNativeRisuPackage } from './risu-native-projection.js';

/** Historical receipts remain readable, but must not supply evaluated retired input to new work. */
export const nativeRisuLegacyReceipt = (snapshot: RunSnapshot): boolean =>
  snapshot.nativeRisuExecution?.version === 1 ||
  snapshot.nativeRisuPresetProgram?.version === 1 ||
  snapshot.promptCompilation?.compilerVersion === 'risu-native-prompt-1';

export function nativeRisuSnapshotNeedsRefresh(snapshot: RunSnapshot): boolean {
  const packages = nativeRisuPackages(snapshot);
  if (nativeRisuLegacyReceipt(snapshot) || (packages.length > 0 && !snapshot.nativeRisuExecution))
    return true;
  if (packages.some(({ native }) => !isDeepStrictEqual(native, normalizeRisuContentSource(native))))
    return true;
  return Object.values(snapshot.profile?.promptPresets ?? {}).some(({ program }) => {
    const preset = program.nativeRisuPreset?.preset;
    if (!preset) return false;
    const supported = structuredClone(preset);
    stripDeprecatedRisuPresetFields(supported);
    return !isDeepStrictEqual(preset, supported);
  });
}

/** A fresh request uses the frozen authored source, never current library revisions or old output. */
export function supportedNativeRisuSnapshot(snapshot: RunSnapshot): RunSnapshot {
  const input = structuredClone(snapshot);
  if (input.profile?.packages)
    input.profile.packages = input.profile.packages.map((pkg) => {
      const role = input.profile?.packageAttachments?.find(
        (ref) => ref.id === pkg.id && ref.revision === pkg.revision
      )?.role;
      return pkg.nativeRisu
        ? projectNativeRisuPackage(pkg, role ?? (pkg.identity ? 'bot' : 'module')).pkg
        : pkg;
    });
  for (const preset of Object.values(input.profile?.promptPresets ?? {}))
    if (preset.program.nativeRisuPreset)
      stripDeprecatedRisuPresetFields(preset.program.nativeRisuPreset.preset);
  delete input.nativeRisuExecution;
  delete input.nativeRisuPresetProgram;
  delete input.promptCompilation;
  input.resources = [
    ...input.resources.filter((resource) => !resource.id.startsWith('package:')),
    ...compiledPackages(input, 'main').flatMap((pkg) => pkg.resources),
  ];
  return input;
}

/** Pure input projection for an independent artifact or manual context operation.
 * CBS/regex writes remain in this copy; Lua/V2 callbacks, persistent VMs and paid hosts are absent.
 */
export async function prepareNativeRisuReadOnly(
  snapshot: RunSnapshot,
  purpose: 'artifact' | 'context' | 'auxiliary'
): Promise<RunSnapshot> {
  if (
    !nativeRisuPackages(snapshot).length &&
    !snapshot.profile?.promptPresets?.main?.program.nativeRisuPreset
  )
    return snapshot;
  const input = supportedNativeRisuSnapshot(snapshot);
  const prepared = await prepareNativeRisuRun(input, { preview: true });
  prepared.nativeRisuExecution!.issues = prepared.nativeRisuExecution!.issues.map((issue) =>
    issue === 'RISU_NATIVE_PREVIEW_CALLBACKS_DEFERRED'
      ? `RISU_NATIVE_${purpose.toUpperCase()}_CALLBACKS_DEFERRED`
      : issue
  );
  prepared.resources = [
    ...prepared.resources.filter((resource) => !resource.id.startsWith('package:')),
    ...compiledPackages(prepared, 'main').flatMap((pkg) => pkg.resources),
  ];
  return prepared;
}
