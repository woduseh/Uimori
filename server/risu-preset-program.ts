import { promptControls } from '../core/risu-prompt.js';
import { validateRisuPrompt } from '../core/risu-prompt.js';
import {
  createNativeRisuPresetProgram,
  nativeRisuPresetSource,
} from '../core/risu-native-preset.js';
import type { RisuPresetProgramImport } from '../core/risu-preset.js';

/** RISUP prompt source is authoritative. CBS and regex are preserved, never translated to an AST. */
export function importRisuPresetProgram(value: unknown): RisuPresetProgramImport {
  const native = nativeRisuPresetSource(value);
  const program = validateRisuPrompt(createNativeRisuPresetProgram(native));
  return {
    title: typeof native.preset.name === 'string' ? native.preset.name : 'Risu 프리셋',
    role: 'main',
    program,
    values: {},
    findings: [
      {
        code: 'RISU_PRESET_NATIVE_PROMPT',
        level: 'warning',
        message:
          '프롬프트 구성·CBS·토글·기본 변수·정규식을 원래 형식으로 사용해요. 모델·연결·생성 설정은 Uimori의 선택을 유지해요.',
      },
      ...(promptControls(program).length
        ? [
            {
              code: 'RISU_PRESET_UNSET_TOGGLES',
              level: 'warning' as const,
              message:
                '원본에 현재 전역 토글 값이 없어 미설정으로 시작해요. 사용할 옵션을 선택해 주세요.',
            },
          ]
        : []),
    ],
  };
}
