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
        message: `${index + 1}번 블록(${String(item.type)})은 원본만 보존해요. 실행하려면 지원하는 네이티브 블록으로 수정해야 해요.`,
      })),
      ...['utilOverride', 'customChainOfThought']
        .filter((key) => settings?.[key] === true)
        .map((key) => ({
          code: 'RISU_PRESET_HOST_SETTING',
          level: 'unsupported' as const,
          path: `promptSettings.${key}`,
          message: `${key}의 Risu 앱 내장 프롬프트 전환은 실행하지 않아요. 명시한 네이티브 블록과 Uimori의 작업·모델 설정을 사용해요.`,
        })),
      ...((native.preset.promptTemplate as Record<string, unknown>[]).some(
        (item) => item.type === 'memory'
      )
        ? [
            {
              code: 'RISU_PRESET_HOST_MEMORY',
              level: 'warning' as const,
              message:
                'memory 블록의 위치·감싸는 문구는 적용하지 않아요. 요약과 기억은 Uimori의 문맥 정책으로 전달해요.',
            },
          ]
        : []),
      {
        code: 'RISU_PRESET_NATIVE_PROMPT',
        level: 'warning',
        message:
          '프롬프트 구성·CBS·토글·기본 변수·정규식을 원래 형식으로 사용해요. 모델·연결·생성 설정은 Uimori의 선택을 유지해요.',
      },
    ],
  };
}
