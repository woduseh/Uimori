import { resolvePromptValues, validateRisuPrompt } from '../core/risu-prompt.js';
import {
  createNativeRisuPresetProgram,
  NATIVE_RISU_PRESET_BLOCKS,
  NATIVE_RISU_PRESET_SKIPPED_BLOCKS,
  nativeRisuPresetSource,
} from '../core/risu-native-preset.js';
import type { RisuPresetFinding, RisuPresetProgramImport } from '../core/risu-preset.js';

export const RISU_PRESET_IGNORED_SETTINGS: readonly string[] = [
  'utilOverride',
  'customChainOfThought',
];

export function importRisuPresetProgram(value: unknown): RisuPresetProgramImport {
  const native = nativeRisuPresetSource(value);
  const program = validateRisuPrompt(createNativeRisuPresetProgram(native));
  const supported = new Set([...NATIVE_RISU_PRESET_BLOCKS, ...NATIVE_RISU_PRESET_SKIPPED_BLOCKS]);
  const unsupported = (native.preset.promptTemplate as Record<string, unknown>[])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !supported.has(String(item.type)));
  const settings = native.preset.promptSettings as Record<string, unknown> | undefined;
  return {
    title: typeof native.preset.name === 'string' ? native.preset.name : 'Risu 프리셋',
    role: 'main',
    program,
    values: resolvePromptValues(program),
    findings: [
      ...unsupported.map(
        ({ item, index }): RisuPresetFinding => ({
          code: 'RISU_PRESET_UNSUPPORTED_BLOCK',
          level: 'unsupported',
          params: { position: index + 1, type: String(item.type) },
        })
      ),
      ...RISU_PRESET_IGNORED_SETTINGS.filter((key) => settings?.[key] === true).map(
        (setting): RisuPresetFinding => ({
          code: 'RISU_PRESET_HOST_SETTING',
          level: 'unsupported',
          params: { setting },
        })
      ),
      ...((native.preset.promptTemplate as Record<string, unknown>[]).some(
        (item) => item.type === 'memory'
      )
        ? [{ code: 'RISU_PRESET_HOST_MEMORY', level: 'warning' } satisfies RisuPresetFinding]
        : []),
    ],
  };
}
