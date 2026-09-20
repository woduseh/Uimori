import { nativeRisuPresetControls, nativeRisuToggleControls } from './risu-native-preset.js';
import { nativeRisuExtension } from './risu-native.js';
import type { ProfileSnapshot } from './product.js';
import type { PromptControl, PromptValue, RisuPrompt } from './risu-prompt.js';

/** Computed UI/runtime metadata only. The preset and attached card/module sources stay untouched. */
export function effectiveRisuControls(
  profile: Pick<ProfileSnapshot, 'packages' | 'packageAttachments'>,
  program?: RisuPrompt
): PromptControl[] {
  const result = program ? nativeRisuPresetControls(program.nativeRisuPreset) : [];
  const seen = new Map(result.map((item) => [item.id, item]));
  const attachments = profile.packageAttachments ?? [];
  const ordered = [
    ...attachments.filter((item) => item.role !== 'bot'),
    ...attachments.filter((item) => item.role === 'bot'),
  ];
  for (const ref of ordered) {
    const native = profile.packages?.find(
      (item) => item.id === ref.id && item.revision === ref.revision
    )?.nativeRisu;
    if (!native) continue;
    const declaration = native.module?.customModuleToggle ?? nativeRisuExtension(native).toggles;
    for (const control of nativeRisuToggleControls(
      typeof declaration === 'string' ? declaration : ''
    )) {
      const existing = seen.get(control.id);
      if (existing) {
        if (
          existing.type !== control.type ||
          JSON.stringify(existing.options?.map((option) => option.value)) !==
            JSON.stringify(control.options?.map((option) => option.value))
        )
          throw new Error(`RISU_NATIVE_TOGGLE_CONFLICT (${control.nativeKey ?? control.id})`);
        continue;
      }
      seen.set(control.id, control);
      result.push(control);
    }
  }
  return result;
}

export function nativeToggleVariables(
  controls: PromptControl[],
  values: Record<string, PromptValue>
): Record<string, string> {
  return Object.fromEntries(
    controls.map((control) => [
      `toggle_${control.nativeKey ?? control.id}`,
      String(values[control.id] ?? null),
    ])
  );
}
