import type {
  PromptControl,
  PromptExpression,
  PromptOperation,
  PromptTemplate,
} from '../core/prompt-program.js';

const op = (name: PromptOperation, ...args: PromptExpression[]): PromptExpression => ({
  op: name,
  args,
});
const exactTrue = (value: PromptExpression) =>
  op('any', op('equal', value, '1'), op('equal', value, 'true'));
export class UnsupportedCbs extends Error {}

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

/** Risu normalizes a command before looking it up: parser.svelte.ts:1088 lowercases and drops
 * spaces, underscores and hyphens. `{{//…}}` is matched on the raw body instead, as a prefix. */
const commandName = (command: string) => command.toLowerCase().replace(/[\s_-]/gu, '');
const isCommentCbs = (body: string, command: string) =>
  body.startsWith('//') || commandName(command) === 'comment';

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

export class RisuCbs {
  constructor(
    private controls: Map<string, PromptControl>,
    private options: { messageContext?: boolean; names?: 'slots' | 'context' } = {}
  ) {}

  private variable(name: PromptExpression): PromptExpression {
    if (typeof name === 'string' && ['__proto__', 'prototype', 'constructor'].includes(name))
      throw new UnsupportedCbs('지원하지 않는 변수 이름');
    // Risu renders nested CBS arguments to strings before looking up the variable key.
    const key = typeof name === 'string' ? name : op('replace', name, '', '');
    return op('coalesce', op('get', { context: ['variables'] }, key), 'null');
  }

  /** Conservative fallback keeps unknown syntax literal while still resolving known names. */
  namesOnly(source: string): PromptTemplate | undefined {
    const nodes: PromptTemplate = [];
    let offset = 0;
    for (const match of source.matchAll(/\{\{(char|user)\}\}/giu)) {
      if (match.index > offset)
        nodes.push({ kind: 'text', text: source.slice(offset, match.index) });
      nodes.push({
        kind: 'value',
        expression: { context: [match[1].toLowerCase() === 'char' ? 'bot' : 'user', 'name'] },
      });
      offset = match.index + match[0].length;
    }
    if (!nodes.length) return;
    if (offset < source.length) nodes.push({ kind: 'text', text: source.slice(offset) });
    return nodes;
  }

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
    // A comment contributes nothing to the value it sits in, so it never fails the whole field.
    if (isCommentCbs(token.body, command)) return '';
    if (raw.length === 0 && (command.toLowerCase() === 'char' || command.toLowerCase() === 'user'))
      return { context: [command.toLowerCase() === 'char' ? 'bot' : 'user', 'name'] };
    if (this.options.messageContext && raw.length === 0) {
      if (command === 'chatindex' || command === 'chat_index')
        return { context: ['message', 'index'] };
      if (command === 'lastmessageid' || command === 'lastmessageindex')
        return { context: ['message', 'lastIndex'] };
    }
    if (command === 'getglobalvar' && raw.length === 1 && raw[0].startsWith('toggle_'))
      return this.control(raw[0].slice(7));
    if (['setvar', 'setdefaultvar', 'addvar'].includes(command))
      throw new UnsupportedCbs('지속 채팅 변수 변경');
    const args = raw.map((arg) => this.expression(arg, depth + 1));
    if (command === 'getvar' && args.length === 1) return this.variable(args[0]);
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
    if (raw.length === 2 && raw[0] === 'var')
      return { condition: exactTrue(this.variable(this.expression(raw[1]))), trimLines };
    if (raw.length === 2 && raw[0] === 'not')
      return { condition: op('not', exactTrue(this.expression(raw[1]))), trimLines };
    if (raw.length === 3) {
      const [left, operator, right] = raw;
      if (operator === 'vis' || operator === 'visnot')
        return {
          condition: op(
            operator === 'vis' ? 'equal' : 'notEqual',
            this.variable(this.expression(left)),
            this.expression(right)
          ),
          trimLines,
        };
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
        if (header === ':else' || header === '/when' || header === '/if' || header === '/') {
          if (!nested) throw new UnsupportedCbs('짝이 없는 CBS 블록');
          return { nodes, end: header };
        }
        if (header.startsWith('#if ') || header.startsWith('#if_pure ')) {
          const pure = header.startsWith('#if_pure ');
          const condition = exactTrue(this.expression(header.slice(pure ? 9 : 4)));
          const yes = walk(true, depth + 1);
          if (yes.end !== '/if' && yes.end !== '/')
            throw new UnsupportedCbs('지원하지 않는 if 블록 또는 닫기');
          nodes.push({
            kind: 'if',
            condition,
            then: yes.nodes,
            ...(!pure ? { trimIndent: true } : {}),
          });
        } else if (header.startsWith('#when::') || header.startsWith('#when ')) {
          const condition = this.condition(header);
          const yes = walk(true, depth + 1);
          const no = yes.end === ':else' ? walk(true, depth + 1) : undefined;
          if (!['/when', '/'].includes(no?.end ?? yes.end ?? ''))
            throw new UnsupportedCbs('닫히지 않은 조건 블록');
          nodes.push({
            kind: 'if',
            ...condition,
            then: yes.nodes,
            ...(no ? { else: no.nodes } : {}),
          });
        } else if (isCommentCbs(header, argumentsOf(header)[0])) {
          // Risu renders a comment as nothing outside the display path, so no node is emitted.
        } else if (this.options.names !== 'context' && (header === 'slot' || header === 'char')) {
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
