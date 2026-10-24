import { resolvePromptValues, validateRisuPrompt } from '../core/risu-prompt.js';
import {
  createNativeRisuPresetProgram,
  nativeRisuPresetSource,
} from '../core/risu-native-preset.js';
import type { RisuPresetProgramImport } from '../core/risu-preset.js';

/** RISUP prompt source is authoritative. CBS and regex are preserved, never translated to an AST. */
export function importRisuPresetProgram(value: unknown): RisuPresetProgramImport {
  const native = nativeRisuPresetSource(value);
  const program = validateRisuPrompt(createNativeRisuPresetProgram(native));
  const supported = new Set([
    'plain',
    'chatML',
    'chat',
    'cache',
    'persona',
    'description',
    'lorebook',
    'authornote',
    'postEverything',
    'memory',
  ]);
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
      ...['utilOverride', 'customChainOfThought']
        .filter((key) => settings?.[key] === true)
        .map((key) => ({
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
      {
        code: 'RISU_PRESET_NATIVE_PROMPT',
        level: 'warning',
        message:
          '프롬프트 구성, CBS, 토글, 기본 변수, 정규식을 원래 형식으로 사용해요. 모델, 연결, 생성 설정은 Uimori의 선택을 유지해요.',
      },
    ],
  };
}
