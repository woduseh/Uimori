import { resolvePromptValues } from '../core/prompt-program.js';
import type { RunSnapshot } from '../core/types.js';

/** Explicitly selected controls carry their authored meaning without disclosing other options. */
export function agentSharedOptions(snapshot: RunSnapshot) {
  const preset = snapshot.profile?.promptPresets?.main;
  if (!preset?.program.collaboration?.enabled) return [];
  const values =
    snapshot.promptCompilation?.values ??
    resolvePromptValues(
      preset.program,
      snapshot.profile?.promptControls?.[`${preset.id}@${preset.revision}`]?.values
    );
  return preset.program.collaboration.sharedControls.map((id) => {
    const control = preset.program.controls.find((item) => item.id === id)!;
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
