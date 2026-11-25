import { resolvePromptValues, validateRisuPrompt } from '../core/risu-prompt.js';
import {
  createNativeRisuPresetProgram,
  NATIVE_RISU_PRESET_BLOCKS,
  NATIVE_RISU_PRESET_SKIPPED_BLOCKS,
  nativeRisuPresetSource,
} from '../core/risu-native-preset.js';
import type { RisuPresetProgramImport } from '../core/risu-preset.js';

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
      ...unsupported.map(({ item, index }) => ({
        code: 'RISU_PRESET_UNSUPPORTED_BLOCK',
        level: 'unsupported' as const,
        path: `promptTemplate[${index}]`,
        message: `${index + 1}번 블록(${String(item.type)})은 저장되지만 실행되지 않아요. 실행하려면 지원하는 종류의 프롬프트 블록으로 바꿔 주세요.`,
      })),
      ...RISU_PRESET_IGNORED_SETTINGS.filter((key) => settings?.[key] === true).map((key) => ({
        code: 'RISU_PRESET_HOST_SETTING',
        level: 'unsupported' as const,
        path: `promptSettings.${key}`,
        message: `${key}로 지정한 Risu 내장 프롬프트 설정은 적용하지 않아요. 프리셋의 프롬프트 블록과 Uimori의 작업과 모델 설정을 사용해요.`,
      })),
      ...((native.preset.promptTemplate as Record<string, unknown>[]).some(
        (item) => item.type === 'memory'
      )
        ? [
            {
              code: 'RISU_PRESET_HOST_MEMORY',
              level: 'warning' as const,
              message:
                'memory 블록에 지정한 위치와 앞뒤 문구는 적용하지 않아요. 요약과 기억을 모델에 보낼 때는 Uimori의 컨텍스트 처리 방식을 따라요.',
            },
          ]
        : []),
    ],
  };
}
