import {
  validatePromptProgram,
  type PromptControl,
  type PromptTextTransform,
} from '../core/prompt-program.js';
import type { RisuPresetFinding } from '../core/risu-preset.js';
import { RisuCbs } from './risu-cbs.js';
import { collectRisuRegexRules } from './risu-regex-rules.js';

/** Convert the pinned Risu text stages without executing patterns, CBS, or external work. */
export function importRisuPresetRegex(
  value: unknown,
  controls: PromptControl[]
): { transforms: PromptTextTransform[]; findings: RisuPresetFinding[] } {
  const cbs = new RisuCbs(new Map(controls.map((control) => [control.id, control])), {
    messageContext: true,
  });
  const { rules, findings } = collectRisuRegexRules<PromptTextTransform>(value, {
    stages: { editprocess: 'input', editdisplay: 'display' },
    stageReason: '전송 전·표시 이외의 처리 단계예요.',
    rejectedReplacements: [{ pattern: /^@@/u, reason: '채팅 변경·이동 등의 특수 명령이 있어요.' }],
    allowNoEndNewline: true,
    ruleId: (index) => `risu-regex-${index + 1}`,
    findingCode: (index, kind) =>
      kind === 'list' ? 'RISU_PRESET_REGEX_LIST' : `RISU_PRESET_REGEX_${index + 1}_UNSUPPORTED`,
    build: ({ index, id, stage, item, pattern, flags, replacement }, skip) => {
      try {
        // Captures are expanded by the regex worker after template evaluation. Reading them
        // inside CBS would reverse Risu's order; leave such mixed rules unconverted.
        if (replacement.includes('{{') && /\$(?:[1-9]|[&`']|<)/u.test(replacement))
          throw new Error('캡처 결과를 함께 사용하는 CBS의 평가 순서');
        const replacementTemplate = replacement.includes('{{')
          ? cbs.template(replacement)
          : undefined;
        const transform: PromptTextTransform = {
          id,
          title:
            typeof item.comment === 'string' && item.comment.trim()
              ? item.comment.slice(0, 160)
              : `정규식 ${index + 1}`,
          stage,
          role: 'all',
          pattern,
          flags,
          replacement,
          ...(replacementTemplate ? { replacementTemplate } : {}),
        };
        validatePromptProgram({ version: 1, controls, blocks: [], transforms: [transform] });
        return transform;
      } catch (error) {
        skip(`${error instanceof Error ? error.message : '지원하지 않는 CBS'} 처리예요.`);
        return undefined;
      }
    },
  });
  const result: RisuPresetFinding[] = findings;
  if (rules.length > 32) {
    result.push({
      code: 'RISU_PRESET_REGEX_LIMIT',
      level: 'unsupported',
      message:
        '정규식이 32개를 넘어 전체 묶음을 자동 적용하지 않아요. 순서를 보존한 별도 이식이 필요해요.',
    });
    return { transforms: [], findings: result };
  }
  if (rules.length)
    result.unshift({
      code: 'RISU_PRESET_REGEX_CONTEXT',
      level: 'warning',
      message:
        '정규식은 Uimori의 과거 대화·현재 입력과 본문 표시 사본에 적용해요. 메시지 위치는 이 대화 순서로 계산하며 저장 원문은 유지해요. 치환문의 지원 CBS만 평가하고 메시지 전체의 CBS 재평가·Risu 화면 동작은 복제하지 않아요.',
    });
  return { transforms: rules, findings: result };
}
