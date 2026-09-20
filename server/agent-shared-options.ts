import { promptControls } from '../core/risu-prompt.js';
import { resolveControlValues } from '../core/risu-prompt.js';
import { effectiveRisuControls } from '../core/risu-effective-controls.js';
import type { RunSnapshot } from '../core/types.js';

/** Explicitly selected controls carry their authored meaning without disclosing other options. */
export function agentSharedOptions(snapshot: RunSnapshot) {
  const preset = snapshot.profile?.promptPresets?.main;
  if (!preset?.program.collaboration?.enabled) return [];
  const values =
    snapshot.promptCompilation?.values ??
    resolveControlValues(
      effectiveRisuControls(snapshot.profile!, preset.program),
      snapshot.profile?.promptControls?.[`${preset.id}@${preset.revision}`]?.values
    );
  return preset.program.collaboration.sharedControls.map((id) => {
    const control = promptControls(preset.program).find((item) => item.id === id)!;
    const value = values[id];
    const option = control.options?.find((item) => item.value === value);
    return {
      id,
      label: control.label,
      value,
      ...(control.description ? { description: control.description } : {}),
      ...(option ? { optionLabel: option.label } : {}),
    };
  });
}
