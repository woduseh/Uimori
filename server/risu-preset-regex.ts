import {
  validatePromptProgram,
  type PromptControl,
  type PromptTextTransform,
} from '../core/prompt-program.js';
import type { RisuPresetFinding } from '../core/risu-preset.js';
import { PresetCbs } from './risu-preset-program.js';

/** Convert the pinned Risu text stages without executing patterns, CBS, or external work. */
export function importRisuPresetRegex(
  value: unknown,
  controls: PromptControl[]
): { transforms: PromptTextTransform[]; findings: RisuPresetFinding[] } {
  if (value === undefined) return { transforms: [], findings: [] };
  const findings: RisuPresetFinding[] = [];
  const rules: { index: number; order: number; transform: PromptTextTransform }[] = [];
  const unsupported = (index: number, reason: string) =>
    findings.push({
      code: `RISU_PRESET_REGEX_${index + 1}_UNSUPPORTED`,
      level: 'unsupported',
      message: `정규식 ${index + 1}: ${reason} 원본에 보존하고 자동 적용하지 않아요.`,
    });
  if (!Array.isArray(value) || value.length > 2000)
    return {
      transforms: [],
      findings: [
        {
          code: 'RISU_PRESET_REGEX_LIST',
          level: 'unsupported',
          message: '정규식 목록 형식이나 개수가 지원 범위를 벗어났어요.',
        },
      ],
    };
  const cbs = new PresetCbs(new Map(controls.map((control) => [control.id, control])), true);
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      unsupported(index, '규칙 형식을 읽을 수 없어요.');
      continue;
    }
    const item = raw as Record<string, unknown>;
    if (item.type === 'disabled' || item.in === '') continue;
    if (item.type !== 'editprocess' && item.type !== 'editdisplay') {
      unsupported(index, '전송 전·표시 이외의 처리 단계예요.');
      continue;
    }
    if (
      typeof item.in !== 'string' ||
      typeof item.out !== 'string' ||
      item.in.length > 4096 ||
      item.out.length > 16_384
    ) {
      unsupported(index, '패턴이나 치환문 형식·길이가 지원 범위를 벗어났어요.');
      continue;
    }
    if (item.out.startsWith('@@')) {
      unsupported(index, '채팅 변경·이동 등의 특수 명령이 있어요.');
      continue;
    }
    let flags = item.ableFlag ? (typeof item.flag === 'string' ? item.flag || 'g' : 'g') : 'g';
    let order = 0,
      invalidAction = false,
      noEndNewline = false;
    if (item.ableFlag)
      flags = flags.replace(/<([^>]+)>/gu, (_match, body: string) => {
        for (const action of body.split(',').map((part) => part.trim())) {
          if (/^order -?\d+$/u.test(action)) order = Number(action.slice(6));
          else if (action === 'no_end_nl') noEndNewline = true;
          else invalidAction = true;
        }
        return '';
      });
    if (invalidAction || !Number.isSafeInteger(order)) {
      unsupported(index, 'CBS 패턴·주입·이동 등의 특수 플래그가 있어요.');
      continue;
    }
    flags = [...new Set(flags.trim().replace(/[^dgimsuvy]/gu, ''))].join('') || 'u';
    if (flags.includes('v')) {
      unsupported(index, 'Unicode 집합(v) 플래그는 아직 지원하지 않아요.');
      continue;
    }
    flags = flags.replace('d', '');
    let replacement = item.out.replaceAll('$n', '\n');
    if (replacement.endsWith('>') && !noEndNewline) replacement += '\n';
    if (replacement.length > 16_384) {
      unsupported(index, '변환한 치환문이 허용 길이를 넘어요.');
      continue;
    }
    try {
      // Captures are expanded by the regex worker after template evaluation. Reading them
      // inside CBS would reverse Risu's order; leave such mixed rules unconverted.
      if (replacement.includes('{{') && /\$(?:[1-9]|[&`']|<)/u.test(replacement))
        throw new Error('캡처 결과를 함께 사용하는 CBS의 평가 순서');
      const replacementTemplate = replacement.includes('{{')
        ? cbs.template(replacement)
        : undefined;
      const transform: PromptTextTransform = {
        id: `risu-regex-${index + 1}`,
        title:
          typeof item.comment === 'string' && item.comment.trim()
            ? item.comment.slice(0, 160)
            : `정규식 ${index + 1}`,
        stage: item.type === 'editprocess' ? 'input' : 'display',
        role: 'all',
        pattern: item.in,
        flags,
        replacement,
        ...(replacementTemplate ? { replacementTemplate } : {}),
      };
      validatePromptProgram({ version: 1, controls, blocks: [], transforms: [transform] });
      rules.push({ index, order, transform });
    } catch (error) {
      unsupported(
        index,
        `${error instanceof Error ? error.message : '지원하지 않는 CBS'} 처리예요.`
      );
    }
  }
  if (rules.length > 32) {
    findings.push({
      code: 'RISU_PRESET_REGEX_LIMIT',
      level: 'unsupported',
      message:
        '정규식이 32개를 넘어 전체 묶음을 자동 적용하지 않아요. 순서를 보존한 별도 이식이 필요해요.',
    });
    return { transforms: [], findings };
  }
  rules.sort((left, right) => right.order - left.order || left.index - right.index);
  if (rules.length)
    findings.unshift({
      code: 'RISU_PRESET_REGEX_CONTEXT',
      level: 'warning',
      message:
        '정규식은 Uimori의 과거 대화·현재 입력과 본문 표시 사본에 적용해요. 메시지 위치는 이 대화 순서로 계산하며 저장 원문은 유지해요. 치환문의 지원 CBS만 평가하고 메시지 전체의 CBS 재평가·Risu 화면 동작은 복제하지 않아요.',
    });
  return { transforms: rules.map((item) => item.transform), findings };
}
