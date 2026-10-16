import { nativeRisuToggleControls } from './risu-native-preset.js';
import {
  reconcilePromptValues,
  type PromptControl,
  type PromptValue,
  type RisuPrompt,
} from './risu-prompt.js';

const declarationPath = '/nativeRisuPreset/preset/customPromptTemplateToggle';
const maxDiagnostics = 200;
type SourceRange = { start: number; end: number; line: number };
export type RisuPresetDiagnostic = {
  code:
    | 'toggle_declaration_type'
    | 'toggle_key_invalid'
    | 'toggle_key_duplicate'
    | 'toggle_value_unknown'
    | 'toggle_value_invalid'
    | 'toggle_option_meaning_changed'
    | 'toggle_option_removed'
    | 'toggle_removed'
    | 'toggle_type_changed';
  severity: 'warning' | 'info';
  message: string;
  /** JSON Pointer relative to the program, except /values for the separate selected-values input. */
  path: string;
  /** Zero-based UTF-16 offsets, exclusive end, and one-based line in the declaration string. */
  range?: SourceRange;
  controlId?: string;
  option?: { value: string; previousLabel: string; currentLabel?: string };
};
type Declaration = {
  controls: PromptControl[];
  ranges: Map<string, SourceRange>;
  valid: boolean;
};

/** Use the execution owner's permissive declaration projection, not the stricter UI editor grammar. */
function declaration(
  program: RisuPrompt,
  report: (diagnostic: RisuPresetDiagnostic) => void
): Declaration {
  const source = program.nativeRisuPreset.preset.customPromptTemplateToggle;
  const result: Declaration = { controls: [], ranges: new Map(), valid: true };
  if (source === undefined) return result;
  if (typeof source !== 'string') {
    report({
      code: 'toggle_declaration_type',
      severity: 'warning',
      message: '토글 선언이 문자열이 아니어서 현재 실행에서는 읽히지 않아요.',
      path: declarationPath,
    });
    result.valid = false;
    return result;
  }
  let offset = 0;
  for (const [index, raw] of source.split('\n').entries()) {
    const line = raw.replace(/\r$/u, '');
    const range = { start: offset, end: offset + line.length, line: index + 1 };
    offset += raw.length + 1;
    let control: PromptControl | undefined;
    try {
      [control] = nativeRisuToggleControls(raw);
    } catch {
      result.valid = false;
      report({
        code: 'toggle_key_invalid',
        severity: 'warning',
        message: '토글 키가 현재 실행 규칙을 벗어나요. 키 길이와 제어 문자를 확인해 주세요.',
        path: declarationPath,
        range,
      });
      continue;
    }
    if (!control) continue;
    if (result.ranges.has(control.id)) {
      result.valid = false;
      report({
        code: 'toggle_key_duplicate',
        severity: 'warning',
        message: '같은 토글 키가 앞에서 이미 선언되어 있어요.',
        path: declarationPath,
        range,
        controlId: control.id,
      });
      continue;
    }
    result.controls.push(control);
    result.ranges.set(control.id, range);
  }
  return result;
}

const labelPreview = (value: string) => (value.length > 160 ? `${value.slice(0, 159)}…` : value);
const pointerKey = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');

/**
 * Read-only advice on native toggle declarations and saved selections. The input program's shape
 * is validated by its resource owner. This never executes CBS or returns replacement saved values.
 *
 * CBS source: RisuAI cad8595aa39620df4246f56918f0962c2aa0263a, parser/parser.svelte.ts,
 * vendored at third_party/risuai/cad8595a/cbs-parser.ts. Its evaluator accepts unmatched closing
 * names, restores incomplete tags, and reparses dynamic calls/loops. A separate brace/regex checker
 * would not be a syntax validator; importing the evaluator would execute stateful source instead.
 */
export function diagnoseRisuPreset(
  program: RisuPrompt,
  values: Record<string, PromptValue> = {},
  previousProgram?: RisuPrompt
) {
  const diagnostics: RisuPresetDiagnostic[] = [];
  let totalDiagnostics = 0;
  const report = (diagnostic: RisuPresetDiagnostic) => {
    totalDiagnostics++;
    if (diagnostics.length < maxDiagnostics) diagnostics.push(diagnostic);
  };
  const current = declaration(program, report);
  const controls = new Map(current.controls.map((control) => [control.id, control]));
  if (current.valid) {
    // Reuse exactly the same null/default, numeric-index and removed-key rules as option application.
    for (const key of reconcilePromptValues(current.controls, values).resetKeys) {
      const known = controls.has(key);
      report({
        code: known ? 'toggle_value_invalid' : 'toggle_value_unknown',
        severity: 'warning',
        message: known
          ? '저장된 선택값이 현재 선언에서 허용되지 않아 기본값 재조정 대상이에요.'
          : '저장된 선택값에 대응하는 토글 선언이 없어 현재 선택에 적용할 수 없어요.',
        path: key.length <= 400 ? `/values/${pointerKey(key)}` : '/values',
        ...(key.length <= 400 ? { controlId: key } : {}),
      });
    }
  }
  let optionChanges:
    | 'not_provided'
    | 'checked'
    | 'skipped_invalid_declarations'
    | 'skipped_invalid_previous_declarations' = 'not_provided';
  if (previousProgram) {
    const previous = declaration(previousProgram, () => {});
    optionChanges = !current.valid
      ? 'skipped_invalid_declarations'
      : !previous.valid
        ? 'skipped_invalid_previous_declarations'
        : 'checked';
    if (optionChanges === 'checked') {
      for (const before of previous.controls) {
        const after = controls.get(before.id);
        const location = {
          path: declarationPath,
          controlId: before.id,
          ...(after ? { range: current.ranges.get(before.id) } : {}),
        };
        if (!after || before.type !== after.type) {
          report({
            ...location,
            code: after ? 'toggle_type_changed' : 'toggle_removed',
            severity: 'info',
            message: after
              ? '이전 버전과 토글 입력 종류가 달라졌어요. 저장값의 의미를 확인해 주세요.'
              : '이전 버전의 토글 선언이 제거되었어요.',
          });
          continue;
        }
        if (before.type !== 'select') continue;
        for (const oldOption of before.options ?? []) {
          const newOption = after.options?.find((option) => option.value === oldOption.value);
          if (newOption?.label === oldOption.label) continue;
          report({
            ...location,
            code: newOption ? 'toggle_option_meaning_changed' : 'toggle_option_removed',
            severity: newOption || values[before.id] === oldOption.value ? 'warning' : 'info',
            message: newOption
              ? '같은 저장값의 선택지 이름이 바뀌었어요. 순서나 이름 변경으로 의미가 달라졌을 수 있어요.'
              : '이전 버전의 선택지가 제거되었어요. 이 값을 사용하는 조건이나 저장값을 확인해 주세요.',
            option: {
              value: String(oldOption.value),
              previousLabel: labelPreview(oldOption.label),
              ...(newOption ? { currentLabel: labelPreview(newOption.label) } : {}),
            },
          });
        }
      }
    }
  }
  return {
    diagnostics,
    totalDiagnostics,
    truncated: totalDiagnostics > diagnostics.length,
    coverage: {
      toggleDeclarations: 'checked' as const,
      selectedValues: current.valid
        ? ('checked' as const)
        : ('skipped_invalid_declarations' as const),
      optionChanges,
      cbsSyntax: false,
      cbsComparisons: false,
      variables: false,
      limitations: [
        'CBS 문법·비교식·변수 참조는 검사하지 않아요. 진단이 없어도 CBS 실행이 검증된 것은 아니에요.',
        '변수는 카드·모듈·대화 상태나 동적 이름에서 제공될 수 있어 미정의·미사용 여부를 판단하지 않아요.',
        '이전 프리셋이 없으면 같은 인덱스의 선택지 의미 변화를 알 수 없어요. 이름 비교만으로 작성 의도를 판정할 수는 없어요.',
      ],
    },
  };
}
