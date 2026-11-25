import { nativeRisuPresetControls, nativeRisuToggleControls } from './risu-native-preset.js';
import { nativeRisuSources } from './risu-native.js';
import type { ProfileSnapshot } from './product.js';
import type { PromptControl, PromptValue, RisuPrompt } from './risu-prompt.js';

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
    for (const control of nativeRisuToggleControls(nativeRisuSources(native).toggles.text)) {
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

export function declaredToggleVariables(
  declaration: string,
  valuesByKey: Record<string, string>
): Record<string, string> {
  const controls = nativeRisuToggleControls(declaration);
  return nativeToggleVariables(
    controls,
    Object.fromEntries(
      controls.flatMap((control) => {
        const key = control.nativeKey ?? control.id;
        return Object.hasOwn(valuesByKey, key) ? [[control.id, valuesByKey[key]!]] : [];
      })
    )
  );
}

export function nativeToggleVariables(
  controls: PromptControl[],
  values: Record<string, PromptValue>
): Record<string, string> {
  return Object.fromEntries(
    controls.map((control) => [
      `toggle_${control.nativeKey ?? control.id}`,
      String(
        Object.hasOwn(values, control.id)
          ? (values[control.id] ?? control.default)
          : control.default
      ),
    ])
  );
}
