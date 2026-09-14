import { createHash } from 'node:crypto';
import {
  validatePromptProgram,
  type PromptBlock,
  type PromptControl,
  type PromptRoleName,
} from '../core/prompt-program.js';
import type { RisuPresetFinding, RisuPresetProgramImport } from '../core/risu-preset.js';

import { RisuCbs, UnsupportedCbs } from './risu-cbs.js';
import { importRisuVariableDefaults } from './risu-variable-defaults.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('RISU_PRESET_INVALID');
  return value as RecordValue;
};
const string = (value: unknown) => (typeof value === 'string' ? value : '');
/** A disabled block keeps its prompt text; the AST caps one text node at 200,000 characters and
 * the whole program at 1MB, so a longer block stays empty rather than failing the import. */
const KEPT_BLOCK_TEXT_LIMIT = 20_000;
function promptRole(value: unknown): PromptRoleName {
  if (value === undefined || value === 'system') return 'system';
  if (value === 'bot' || value === 'assistant') return 'assistant';
  if (value === 'user') return 'user';
  throw new UnsupportedCbs('지원하지 않는 메시지 역할');
}

export function importRisuPresetProgram(value: unknown): RisuPresetProgramImport {
  const preset = record(value);
  if (!Array.isArray(preset.promptTemplate) || preset.promptTemplate.length > 1000)
    throw new Error('RISU_PRESET_PROMPT_TEMPLATE_REQUIRED');
  const findings: RisuPresetFinding[] = [
    {
      code: 'RISU_PRESET_NATIVE_CONTEXT',
      level: 'warning',
      message:
        '자료·현재 입력·과거 대화는 Uimori의 기존 문맥을 사용해요. Risu의 인접 메시지 병합·양끝 공백 정리·캐릭터별 주입 설정은 복제하지 않아요.',
    },
  ];
  const controls = new Map<string, PromptControl>();
  let group: string | undefined;
  for (const line of string(preset.customPromptTemplateToggle).split('\n')) {
    const [key, label, type, options] = line.replace(/\r$/u, '').split('=');
    if (type === 'group') {
      group = label;
      continue;
    }
    if (type === 'groupEnd') {
      group = undefined;
      continue;
    }
    if (type === 'caption' || type === 'divider' || !key || !label) continue;
    if (!/^[A-Za-z0-9_-]{1,120}$/u.test(key) || controls.has(key)) {
      findings.push({
        code: 'RISU_PRESET_TOGGLE_KEY',
        level: 'unsupported',
        message: '중복되거나 지원하지 않는 옵션 키가 있어요.',
      });
      continue;
    }
    const text = type === 'text' || type === 'textarea';
    controls.set(key, {
      id: key,
      label,
      type: text ? 'text' : 'select',
      default: null,
      ...(group ? { group } : {}),
      ...(!text
        ? {
            options: [
              { label: '미설정', value: null },
              ...(type === 'select'
                ? (options ?? '')
                    .split(',')
                    .map((name, index) => ({ label: name, value: String(index) }))
                : [
                    { label: '끔', value: '0' },
                    { label: '켬', value: '1' },
                  ]),
            ],
          }
        : {}),
    });
  }
  const cbs = new RisuCbs(controls);
  const blocks: PromptBlock[] = [];
  const settings = preset.promptSettings ? record(preset.promptSettings) : {};
  for (const [index, raw] of preset.promptTemplate.entries()) {
    const item = record(raw),
      type = string(item.type);
    const common = {
      id: `risu-block-${index + 1}`,
      title: string(item.name) || `${index + 1}. ${type}`,
    };
    try {
      if (type === 'plain' || type === 'jailbreak' || type === 'cot') {
        if (type !== 'plain') throw new UnsupportedCbs('전역 jailbreak/chainOfThought 스위치');
        blocks.push({
          ...common,
          kind: 'message',
          role: promptRole(item.role),
          template: cbs.template(
            string(item.text),
            item.type2 === 'globalNote' ? 'globalNote' : 'slot'
          ),
        });
      } else if (type === 'chat') {
        if (settings.sendChatAsSystem && !item.chatAsOriginalOnSystem)
          throw new UnsupportedCbs('채팅을 시스템 메시지로 변환');
        const from = item.rangeStart === -1000 ? 0 : item.rangeStart;
        const to = item.rangeStart === -1000 ? 'end' : item.rangeEnd;
        if (
          typeof from !== 'number' ||
          !Number.isSafeInteger(from) ||
          !(to === 'end' || (typeof to === 'number' && Number.isSafeInteger(to)))
        )
          throw new UnsupportedCbs('채팅 범위');
        blocks.push({ ...common, kind: 'history', from, to });
      } else if (type === 'cache') {
        if (item.role === 'system') throw new UnsupportedCbs('시스템 메시지 전용 캐시');
        if (
          !['all', 'user', 'assistant'].includes(string(item.role)) ||
          !Number.isSafeInteger(item.depth) ||
          Number(item.depth) < 1
        )
          throw new UnsupportedCbs('캐시 범위');
        blocks.push({
          ...common,
          kind: 'cache',
          depth: Number(item.depth),
          role: item.role as 'all' | 'user' | 'assistant',
          policy: 'prefer',
        });
      } else if (type === 'memory') {
        throw new UnsupportedCbs(
          '기억·요약은 Uimori의 문맥 관리로 전달해요. 과거 요약은 대화 문맥에, 사용자 메모·정정은 별도 참고 정보에 들어가요. 이 Risu 슬롯의 위치와 감싸는 문구는 적용하지 않으며, 메모로 치환하거나 요약을 중복 삽입하지 않아요'
        );
      } else if (
        ['persona', 'description', 'lorebook', 'authornote', 'postEverything'].includes(type)
      ) {
        if (type === 'authornote' && item.defaultText)
          throw new UnsupportedCbs('작성자 노트 기본값');
        const slot = type === 'authornote' ? 'authorNote' : type;
        blocks.push({
          ...common,
          kind: 'slot',
          slot,
          role: promptRole(item.role2),
          ...(item.innerFormat && !['lorebook', 'postEverything'].includes(type)
            ? { template: cbs.template(string(item.innerFormat)) }
            : {}),
        });
      } else throw new UnsupportedCbs('지원하지 않는 프롬프트 블록');
    } catch (error) {
      if (!(error instanceof UnsupportedCbs)) throw error;
      // A text node is never parsed again at render time, so `{{` in the kept prompt text stays
      // visible in the editor instead of running as CBS.
      const original = string(item.text);
      const kept = original.length > 0 && original.length <= KEPT_BLOCK_TEXT_LIMIT;
      const keptNotice = kept
        ? '원문은 꺼진 블록 안에 텍스트로 남겨 편집기에서 고칠 수 있어요. '
        : original
          ? '원문이 길어 꺼진 블록에는 남기지 않아요. '
          : '';
      findings.push({
        code: 'RISU_PRESET_BLOCK_UNSUPPORTED',
        level: 'unsupported',
        blockIndex: index,
        message: `${index + 1}번 블록: ${error.message}. ${keptNotice}원본은 가져온 파일에 보존돼요.`,
      });
      blocks.push({
        ...common,
        kind: 'message',
        role: 'system',
        enabled: false,
        template: kept ? [{ kind: 'text', text: original }] : [],
      });
    }
  }
  if (controls.size)
    findings.push({
      code: 'RISU_PRESET_UNSET_TOGGLES',
      level: 'warning',
      message:
        'Risu 프리셋에는 현재 전역 토글 값이 포함되지 않아요. 미설정 값으로 시작하며, 기본 변수는 전역 토글 값으로 바꾸지 않아요.',
    });
  let variableDefaults: Record<string, string> | undefined;
  try {
    variableDefaults = importRisuVariableDefaults(preset.templateDefaultVariables);
    if (variableDefaults !== undefined)
      findings.push({
        code: 'RISU_PRESET_CHAT_VARIABLE_DEFAULTS',
        level: 'warning',
        message:
          '기본 변수는 공통 템플릿의 읽기 기본값으로 가져와요. 봇의 기본값이 우선하고 프리셋은 빈 키를 보충해요. 전역 토글·저장된 채팅 상태와 별개이며 setvar·Lua 등의 변경은 아직 실행하지 않아요.',
      });
  } catch {
    findings.push({
      code: 'RISU_PRESET_CHAT_VARIABLE_DEFAULTS_INVALID',
      level: 'unsupported',
      message:
        '기본 변수의 형식·이름·크기가 지원 범위를 벗어나 자동 적용하지 않아요. 원본 파일에 보존해요.',
    });
  }
  if (settings.postEndInnerFormat)
    findings.push({
      code: 'RISU_PRESET_POST_END',
      level: 'unsupported',
      message: 'postEndInnerFormat은 적용하지 않았어요.',
    });
  if (settings.assistantPrefill)
    blocks.push({
      id: 'risu-assistant-prefill',
      title: 'Assistant prefill',
      kind: 'message',
      role: 'assistant',
      completion: 'prefill',
      template: cbs.template(string(settings.assistantPrefill)),
    });
  const program = validatePromptProgram({
    version: 1,
    controls: [...controls.values()],
    ...(variableDefaults !== undefined ? { variableDefaults } : {}),
    blocks,
    provenance: {
      sourceHash: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
      variant: 'risu-preset',
      conversionVersion: '3',
      notes: findings.map((finding) => finding.code),
    },
  });
  return {
    title: string(preset.name) || 'Risu 프리셋',
    role: 'main',
    program,
    values: {},
    findings,
  };
}
