import { createHash } from 'node:crypto';
import {
  validatePromptProgram,
  type PromptBlock,
  type PromptControl,
  type PromptExpression,
  type PromptOperation,
  type PromptRoleName,
  type PromptTemplate,
} from '../core/prompt-program.js';
import type { RisuPresetFinding, RisuPresetProgramImport } from '../core/risu-preset.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('RISU_PRESET_INVALID');
  return value as RecordValue;
};
const string = (value: unknown) => (typeof value === 'string' ? value : '');
const op = (name: PromptOperation, ...args: PromptExpression[]): PromptExpression => ({
  op: name,
  args,
});
const exactTrue = (value: PromptExpression) =>
  op('any', op('equal', value, '1'), op('equal', value, 'true'));
class UnsupportedCbs extends Error {}

/** Split at the current CBS nesting level; arguments can themselves contain CBS. */
function argumentsOf(text: string): string[] {
  const parts: string[] = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.slice(i, i + 2) === '{{') {
      depth++;
      i++;
    } else if (text.slice(i, i + 2) === '}}') {
      depth--;
      i++;
    } else if (!depth && text.slice(i, i + 2) === '::') {
      parts.push(text.slice(start, i));
      start = i + 2;
      i++;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function tokenAt(text: string, start: number): { body: string; end: number } {
  let depth = 1;
  for (let i = start + 2; i < text.length - 1; i++) {
    const pair = text.slice(i, i + 2);
    if (pair === '{{') {
      depth++;
      i++;
    } else if (pair === '}}') {
      depth--;
      if (!depth) return { body: text.slice(start + 2, i), end: i + 2 };
      i++;
    }
  }
  throw new UnsupportedCbs('닫히지 않은 CBS');
}

class PresetCbs {
  constructor(private controls: Map<string, PromptControl>) {}

  private control(key: string): PromptExpression {
    if (!this.controls.has(key)) throw new UnsupportedCbs('정의되지 않은 토글 읽기');
    return { control: key };
  }

  expression(source: string, depth = 0): PromptExpression {
    if (depth > 40) throw new UnsupportedCbs('CBS 중첩 한도');
    if (!source.includes('{{')) return source;
    if (!source.startsWith('{{')) throw new UnsupportedCbs('CBS 인수의 텍스트 결합');
    const token = tokenAt(source, 0);
    if (token.end !== source.length) throw new UnsupportedCbs('CBS 인수의 텍스트 결합');
    const [command, ...raw] = argumentsOf(token.body);
    if (command === 'getglobalvar' && raw.length === 1 && raw[0].startsWith('toggle_'))
      return this.control(raw[0].slice(7));
    if (['getvar', 'setvar', 'setdefaultvar', 'addvar'].includes(command))
      throw new UnsupportedCbs('지속 채팅 변수 읽기·변경');
    const args = raw.map((arg) => this.expression(arg, depth + 1));
    const binary: Record<string, PromptOperation> = {
      equal: 'equal',
      notequal: 'notEqual',
      not_equal: 'notEqual',
      greater: 'greater',
      greaterequal: 'greaterEqual',
      greater_equal: 'greaterEqual',
    };
    if (binary[command] && args.length === 2) return op(binary[command], ...args);
    if (
      (command === 'less' || command === 'lessequal' || command === 'less_equal') &&
      args.length === 2
    )
      return op(command === 'less' ? 'greater' : 'greaterEqual', args[1], args[0]);
    if (command === 'length' && args.length === 1) return op('length', ...args);
    if (command === 'replace' && args.length === 3) return op('replace', ...args);
    if ((command === 'and' || command === 'or') && args.length === 2)
      return op(command === 'and' ? 'all' : 'any', ...args.map((arg) => op('equal', arg, '1')));
    if (command === 'any' && args.length > 1)
      return op('any', ...args.map((arg) => op('equal', arg, '1')));
    if (command === 'not' && args.length === 1) return op('not', op('equal', args[0], '1'));
    throw new UnsupportedCbs('지원하지 않는 CBS 명령 또는 인수');
  }

  private condition(header: string): { condition: PromptExpression; trimLines: boolean } {
    const raw = header.startsWith('#when ') ? [header.slice(6)] : argumentsOf(header).slice(1);
    let trimLines = true;
    if (raw[0] === 'keep') {
      trimLines = false;
      raw.shift();
    }
    if (raw[0] === 'legacy') throw new UnsupportedCbs('legacy 공백 처리');
    if (raw.length === 1) return { condition: exactTrue(this.expression(raw[0])), trimLines };
    if (raw.length === 2 && raw[0] === 'toggle')
      return { condition: exactTrue(this.control(raw[1])), trimLines };
    if (raw.length === 2 && raw[0] === 'not')
      return { condition: op('not', exactTrue(this.expression(raw[1]))), trimLines };
    if (raw.length === 3) {
      const [left, operator, right] = raw;
      if (operator === 'tis' || operator === 'tisnot')
        return {
          condition: op(
            operator === 'tis' ? 'equal' : 'notEqual',
            this.control(left),
            this.expression(right)
          ),
          trimLines,
        };
      if (operator === 'is' || operator === 'isnot')
        return {
          condition: op(
            operator === 'is' ? 'equal' : 'notEqual',
            this.expression(left),
            this.expression(right)
          ),
          trimLines,
        };
      if (operator === 'and' || operator === 'or')
        return {
          condition: op(
            operator === 'and' ? 'all' : 'any',
            exactTrue(this.expression(left)),
            exactTrue(this.expression(right))
          ),
          trimLines,
        };
    }
    throw new UnsupportedCbs('지원하지 않는 조건 연산');
  }

  template(source: string, slotName = 'slot'): PromptTemplate {
    let cursor = 0;
    const walk = (nested: boolean, depth: number): { nodes: PromptTemplate; end?: string } => {
      if (depth > 40) throw new UnsupportedCbs('CBS 중첩 한도');
      const nodes: PromptTemplate = [];
      while (cursor < source.length) {
        const start = source.indexOf('{{', cursor);
        if (start < 0) {
          nodes.push({ kind: 'text', text: source.slice(cursor) });
          cursor = source.length;
          break;
        }
        if (start > cursor) nodes.push({ kind: 'text', text: source.slice(cursor, start) });
        const token = tokenAt(source, start);
        cursor = token.end;
        const header = token.body;
        if (header === ':else' || header === '/when' || header === '/') {
          if (!nested) throw new UnsupportedCbs('짝이 없는 CBS 블록');
          return { nodes, end: header };
        }
        if (header.startsWith('#when::') || header.startsWith('#when ')) {
          const condition = this.condition(header);
          const yes = walk(true, depth + 1);
          const no = yes.end === ':else' ? walk(true, depth + 1) : undefined;
          if (!(no?.end ?? yes.end)?.startsWith('/'))
            throw new UnsupportedCbs('닫히지 않은 조건 블록');
          nodes.push({
            kind: 'if',
            ...condition,
            then: yes.nodes,
            ...(no ? { else: no.nodes } : {}),
          });
        } else if (header === 'slot' || header === 'char') {
          nodes.push({ kind: 'slot', name: header === 'slot' ? slotName : 'char' });
        } else {
          nodes.push({
            kind: 'value',
            expression: this.expression(source.slice(start, token.end)),
          });
        }
      }
      if (nested) throw new UnsupportedCbs('닫히지 않은 조건 블록');
      return { nodes };
    };
    return walk(false, 0).nodes;
  }
}

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
  const cbs = new PresetCbs(controls);
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
      findings.push({
        code: 'RISU_PRESET_BLOCK_UNSUPPORTED',
        level: 'unsupported',
        blockIndex: index,
        message: `${index + 1}번 블록: ${error.message}. 원본은 가져온 파일에 보존돼요.`,
      });
      blocks.push({ ...common, kind: 'message', role: 'system', enabled: false, template: [] });
    }
  }
  if (controls.size)
    findings.push({
      code: 'RISU_PRESET_UNSET_TOGGLES',
      level: 'warning',
      message:
        'Risu 프리셋에는 현재 전역 토글 값이 포함되지 않아요. 미설정 값으로 시작하며, 기본 변수는 전역 토글 값으로 바꾸지 않아요.',
    });
  if (preset.templateDefaultVariables)
    findings.push({
      code: 'RISU_PRESET_CHAT_VARIABLE_DEFAULTS',
      level: 'warning',
      message:
        '지속 채팅 변수 기본값은 전역 토글과 별개예요. 이 가져오기는 채팅 변수를 만들지 않아요.',
    });
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
    blocks,
    provenance: {
      sourceHash: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
      variant: 'risu-preset',
      conversionVersion: '1',
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
