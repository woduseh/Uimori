import {
  PROMPT_OPERATION_ARITY,
  type PromptExpression,
  type PromptTemplate,
  type RuntimeValue,
} from './prompt-program.js';
import { validateRuntimeValue, UNSAFE_PROMPT_KEYS } from './prompt-values.js';

export const DEFAULT_PROMPT_SLOTS = [
  'bot.name',
  'user.name',
  'persona',
  'description',
  'lorebook',
  'memory',
  'authorNote',
  'postEverything',
  'slot',
] as const;
const MAX_SOURCE = 200_000,
  MAX_DEPTH = 32,
  MAX_NODES = 5000;
export class PromptLanguageError extends Error {
  readonly statusCode = 400;
  readonly line: number;
  readonly column: number;
  constructor(
    readonly code: string,
    readonly offset: number,
    source: string
  ) {
    const before = source.slice(0, offset),
      lines = before.split('\n');
    super(`${code} (${lines.length}:${lines.at(-1)!.length + 1})`);
    this.name = 'PromptLanguageError';
    this.line = lines.length;
    this.column = lines.at(-1)!.length + 1;
  }
}
type Token = { text: string; at: number; value?: string };

/** Only authored templates enter this parser. Substituted values remain ordinary text. */
export function parsePromptTemplate(
  source: string,
  controlIds: Iterable<string>,
  slots: Iterable<string> = DEFAULT_PROMPT_SLOTS
): PromptTemplate {
  const fail = (code: string, at: number): never => {
    throw new PromptLanguageError(code, at, source);
  };
  if (source.length > MAX_SOURCE) fail('PROMPT_SOURCE_LIMIT', MAX_SOURCE);
  const controls = new Set(controlIds),
    allowedSlots = new Set(slots);
  let cursor = 0,
    nodeCount = 0;
  function tokens(text: string, base: number): Token[] {
    const result: Token[] = [];
    let i = 0;
    while (i < text.length) {
      if (/\s/u.test(text[i])) {
        i++;
        continue;
      }
      const at = i,
        ch = text[i];
      if (ch === '"' || ch === "'") {
        i++;
        let value = '',
          closed = false;
        while (i < text.length) {
          const c = text[i++];
          if (c === ch) {
            closed = true;
            break;
          }
          if (c === '\\') {
            const escaped = text[i++];
            if (escaped === 'u') {
              const hex = text.slice(i, i + 4);
              if (!/^[\da-f]{4}$/iu.test(hex)) fail('PROMPT_INVALID_ESCAPE', base + i);
              value += String.fromCharCode(parseInt(hex, 16));
              i += 4;
            } else {
              const escapes: Record<string, string> = {
                n: '\n',
                r: '\r',
                t: '\t',
                b: '\b',
                f: '\f',
                '\\': '\\',
                '"': '"',
                "'": "'",
                '/': '/',
              };
              if (!Object.hasOwn(escapes, escaped)) fail('PROMPT_INVALID_ESCAPE', base + i - 1);
              value += escapes[escaped];
            }
          } else value += c;
        }
        if (!closed) fail('PROMPT_UNCLOSED_STRING', base + at);
        result.push({ text: 'string', value, at: base + at });
        continue;
      }
      const match =
        /^(?:(?:\d+(?:\.\d+)?)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|==|!=|>=|<=|\*\*|[().,:{}\[\]<>+*/%=-])/u.exec(
          text.slice(i)
        );
      if (!match) fail('PROMPT_INVALID_TOKEN', base + i);
      result.push({ text: match![0], at: base + i });
      i += match![0].length;
    }
    result.push({ text: '', at: base + text.length });
    return result;
  }
  function expression(
    text: string,
    base: number,
    initialScope = new Set<string>()
  ): PromptExpression {
    const ts = tokens(text, base);
    let pos = 0;
    const peek = () => ts[pos].text;
    const take = (expected: string) => {
      if (peek() !== expected) fail('PROMPT_EXPECTED_' + expected, ts[pos].at);
      return ts[pos++];
    };
    const binding = (): string => {
      const token = ts[pos++],
        name = token.text === 'string' ? token.value! : token.text;
      if (!/^[A-Za-z_][A-Za-z_0-9]*$/u.test(name) || UNSAFE_PROMPT_KEYS.has(name))
        fail('PROMPT_INVALID_LOCAL', token.at);
      return name;
    };
    function json(depth = 0): RuntimeValue {
      if (depth > MAX_DEPTH) fail('PROMPT_NESTING_LIMIT', ts[pos].at);
      const token = ts[pos++];
      if (token.text === 'string') return token.value!;
      if (token.text === 'true' || token.text === 'false') return token.text === 'true';
      if (token.text === 'null') return null;
      if (token.text === '-') {
        const n = json(depth + 1);
        if (typeof n !== 'number') fail('PROMPT_INVALID_NUMBER', token.at);
        return -(n as number);
      }
      if (/^\d/u.test(token.text)) {
        const n = Number(token.text);
        if (!Number.isFinite(n)) fail('PROMPT_INVALID_NUMBER', token.at);
        return n;
      }
      if (token.text === '[') {
        const result: RuntimeValue[] = [];
        if (peek() !== ']')
          do {
            if (result.length) take(',');
            if (result.length >= 2000) fail('PROMPT_COLLECTION_LIMIT', token.at);
            result.push(json(depth + 1));
          } while (peek() === ',');
        take(']');
        return result;
      }
      if (token.text === '{') {
        const entries: [string, RuntimeValue][] = [],
          keys = new Set<string>();
        if (peek() !== '}')
          do {
            if (entries.length) take(',');
            const key = take('string').value!;
            if (UNSAFE_PROMPT_KEYS.has(key) || keys.has(key))
              fail('PROMPT_INVALID_LITERAL_KEY', token.at);
            keys.add(key);
            take(':');
            if (entries.length >= 2000) fail('PROMPT_COLLECTION_LIMIT', token.at);
            entries.push([key, json(depth + 1)]);
          } while (peek() === ',');
        take('}');
        return Object.fromEntries(entries);
      }
      return fail('PROMPT_JSON_LITERAL_REQUIRED', token.at);
    }
    function atom(depth: number, scope: Set<string>): PromptExpression {
      if (depth > MAX_DEPTH) fail('PROMPT_NESTING_LIMIT', ts[pos].at);
      const t = ts[pos++];
      if (t.text === 'string') return t.value!;
      if (t.text === 'true' || t.text === 'false') return t.text === 'true';
      if (t.text === 'null') return null;
      if (/^\d/u.test(t.text)) {
        const n = Number(t.text);
        if (!Number.isFinite(n)) fail('PROMPT_INVALID_NUMBER', t.at);
        return n;
      }
      if (t.text === '-') {
        const value = atom(depth + 1, scope);
        return typeof value === 'number' ? -value : { op: 'subtract', args: [0, value] };
      }
      if (t.text === '(') {
        const value = parse(0, depth + 1, scope);
        take(')');
        return value;
      }
      if (t.text === 'not' && peek() !== '(') return { op: 'not', args: [atom(depth + 1, scope)] };
      if (t.text === 'literal' || t.text === '[' || t.text === '{') {
        if (t.text === 'literal') take('(');
        else pos--;
        const value = json();
        if (t.text === 'literal') take(')');
        try {
          return { literal: validateRuntimeValue(value) };
        } catch (error) {
          return fail(error instanceof Error ? error.message : 'PROMPT_INVALID_LITERAL', t.at);
        }
      }
      if (t.text === 'context' || t.text === 'local') {
        const parts: string[] = [];
        while (peek() === '.' || peek() === '[') {
          let name: string;
          if (peek() === '.') {
            take('.');
            name = binding();
          } else {
            take('[');
            const part = ts[pos++];
            if (part.text === 'string') name = part.value!;
            else if (/^(0|[1-9]\d*)$/u.test(part.text)) name = part.text;
            else return fail('PROMPT_INVALID_PATH', part.at);
            take(']');
          }
          if (UNSAFE_PROMPT_KEYS.has(name) || name.length > 200 || parts.length >= 32)
            fail('PROMPT_INVALID_PATH', t.at);
          parts.push(name);
        }
        if (t.text === 'context') return { context: parts };
        const name = parts.shift();
        if (!name || !scope.has(name)) fail('PROMPT_UNKNOWN_LOCAL', t.at);
        return { local: name!, ...(parts.length ? { path: parts } : {}) };
      }
      if (t.text === 'localPath') {
        take('(');
        const name = binding();
        take(',');
        const parts = json();
        take(')');
        if (!scope.has(name)) fail('PROMPT_UNKNOWN_LOCAL', t.at);
        if (
          !Array.isArray(parts) ||
          parts.some((part) => typeof part !== 'string' || UNSAFE_PROMPT_KEYS.has(part))
        )
          fail('PROMPT_INVALID_PATH', t.at);
        return { local: name, path: parts as string[] };
      }
      if (t.text === 'options') {
        let id: string;
        if (peek() === '[') {
          take('[');
          id = take('string').value!;
          take(']');
        } else {
          take('.');
          const name = ts[pos++];
          if (!/^[A-Za-z_][A-Za-z_0-9]*$/u.test(name.text)) fail('PROMPT_INVALID_CONTROL', name.at);
          id = name.text;
        }
        if (!controls.has(id)) fail('PROMPT_UNKNOWN_CONTROL', t.at);
        return { control: id };
      }
      if (['map', 'filter', 'mapIndexed', 'filterIndexed'].includes(t.text)) {
        take('(');
        const source = parse(0, depth + 1, scope);
        take(',');
        const as = binding();
        take(',');
        let index: string | undefined;
        if (t.text.endsWith('Indexed')) {
          index = binding();
          if (index === as) fail('PROMPT_DUPLICATE_LOCAL', t.at);
          take(',');
        }
        const bound = new Set(scope);
        bound.add(as);
        if (index) bound.add(index);
        const value = parse(0, depth + 1, bound);
        take(')');
        return {
          op: t.text.startsWith('map') ? 'map' : 'filter',
          args: [source, value],
          as,
          ...(index ? { index } : {}),
        };
      }
      if (Object.hasOwn(PROMPT_OPERATION_ARITY, t.text)) {
        take('(');
        const args: PromptExpression[] = [];
        if (peek() !== ')') {
          do {
            if (args.length) take(',');
            args.push(parse(0, depth + 1, scope));
            if (args.length > 100) fail('PROMPT_ARGUMENT_LIMIT', t.at);
          } while (peek() === ',');
        }
        take(')');
        const [min, max] = PROMPT_OPERATION_ARITY[t.text as keyof typeof PROMPT_OPERATION_ARITY];
        if (args.length < min || args.length > max || (t.text === 'object' && args.length % 2))
          fail('PROMPT_EXPRESSION_ARITY', t.at);
        return { op: t.text as Extract<PromptExpression, { op: string }>['op'], args };
      }
      return fail('PROMPT_UNKNOWN_EXPRESSION', t.at);
    }
    const precedence: Record<string, number> = {
      or: 1,
      and: 2,
      '==': 3,
      '!=': 3,
      '>': 3,
      '>=': 3,
      '<': 3,
      '<=': 3,
      '+': 4,
      '-': 4,
      '*': 5,
      '/': 5,
      '%': 5,
      '**': 6,
    };
    function parse(min: number, depth: number, scope: Set<string>): PromptExpression {
      let left = atom(depth, scope);
      while ((precedence[peek()] ?? -1) >= min) {
        const operator = ts[pos++],
          rank = precedence[operator.text],
          right = parse(rank + (operator.text === '**' ? 0 : 1), depth + 1, scope);
        const ops = {
          or: 'any',
          and: 'all',
          '==': 'equal',
          '!=': 'notEqual',
          '>': 'greater',
          '>=': 'greaterEqual',
          '<': 'greater',
          '<=': 'greaterEqual',
          '+': 'add',
          '-': 'subtract',
          '*': 'multiply',
          '/': 'divide',
          '%': 'mod',
          '**': 'pow',
        } as const;
        left = {
          op: ops[operator.text as keyof typeof ops],
          args: operator.text.startsWith('<') ? [right, left] : [left, right],
        };
      }
      return left;
    }
    const result = parse(0, 0, initialScope);
    if (peek() !== '') fail('PROMPT_TRAILING_EXPRESSION', ts[pos].at);
    // Left associative operators can grow an AST without growing recursive descent depth.
    const pending: [PromptExpression, number][] = [[result, 0]];
    while (pending.length) {
      const [e, d] = pending.pop()!;
      if (d > MAX_DEPTH) fail('PROMPT_NESTING_LIMIT', base);
      if (e && typeof e === 'object' && 'args' in e)
        for (const a of e.args) pending.push([a, d + 1]);
    }
    return result;
  }
  function tag(): { body: string; base: number; value: boolean; start: number } {
    const start = cursor,
      value = source[cursor + 1] === '{',
      ending = value ? '}}' : '%}';
    cursor += 2;
    const base = cursor;
    let quote = '';
    const brackets: string[] = [];
    while (cursor < source.length) {
      const c = source[cursor];
      if (quote) {
        if (c === '\\') {
          cursor += 2;
          continue;
        }
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (!brackets.length && source.startsWith(ending, cursor)) {
        const body = source.slice(base, cursor);
        cursor += 2;
        return { body, base, value, start };
      } else if ('([{'.includes(c)) {
        brackets.push(c);
        if (brackets.length > 64) fail('PROMPT_NESTING_LIMIT', cursor);
      } else if (')]}'.includes(c)) {
        const expected = { ')': '(', ']': '[', '}': '{' }[c];
        if (brackets.at(-1) === expected) brackets.pop();
      }
      cursor++;
    }
    return fail('PROMPT_UNCLOSED_TAG', start);
  }
  function sequence(
    depth: number,
    nested: boolean,
    scope = new Set<string>()
  ): { nodes: PromptTemplate; stop?: 'else' | 'endif' | 'endeach' | 'endlet' } {
    if (depth > MAX_DEPTH) fail('PROMPT_NESTING_LIMIT', cursor);
    const nodes: PromptTemplate = [];
    const add = (node: PromptTemplate[number]) => {
      if (++nodeCount > MAX_NODES) fail('PROMPT_NODE_LIMIT', cursor);
      nodes.push(node);
    };
    while (cursor < source.length) {
      const next = source.slice(cursor).search(/\{[{%]/u);
      if (next !== 0) {
        const end = next < 0 ? source.length : cursor + next;
        add({ kind: 'text', text: source.slice(cursor, end) });
        cursor = end;
        continue;
      }
      const t = tag(),
        body = t.body.trim();
      if (
        !t.value &&
        (body === 'else' || body === 'endif' || body === 'endeach' || body === 'endlet')
      ) {
        if (!nested) fail('PROMPT_UNEXPECTED_' + body.toUpperCase(), t.start);
        return { nodes, stop: body };
      }
      if (t.value) {
        let name: string | undefined;
        if (
          /^[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*$/u.test(body) &&
          !['true', 'false', 'null', 'context', 'local'].includes(body) &&
          !/^(options|context|local)\./u.test(body)
        )
          name = body;
        else if (/^slot\s*\(/u.test(body)) {
          const ts = tokens(t.body, t.base);
          if (
            ts.length !== 5 ||
            ts[0].text !== 'slot' ||
            ts[1].text !== '(' ||
            ts[2].text !== 'string' ||
            ts[3].text !== ')'
          )
            fail('PROMPT_INVALID_SLOT', t.start);
          name = ts[2].value;
        }
        if (name !== undefined) {
          if (!allowedSlots.has(name)) fail('PROMPT_UNKNOWN_SLOT', t.base);
          add({ kind: 'slot', name });
        } else add({ kind: 'value', expression: expression(t.body, t.base, scope) });
      } else {
        const each =
          /^\s*each\s+([A-Za-z_][A-Za-z_0-9]*)(?:\s*,\s*([A-Za-z_][A-Za-z_0-9]*))?\s+in\s+/u.exec(
            t.body
          );
        const letMatch = /^\s*let\s+([A-Za-z_][A-Za-z_0-9]*)\s*=\s*/u.exec(t.body);
        if (each || letMatch) {
          const match = (each ?? letMatch)!,
            name = match[1],
            index = each?.[2];
          if (UNSAFE_PROMPT_KEYS.has(name) || (index && UNSAFE_PROMPT_KEYS.has(index)))
            fail('PROMPT_INVALID_LOCAL', t.base);
          if (index === name) fail('PROMPT_DUPLICATE_LOCAL', t.base);
          const value = expression(t.body.slice(match[0].length), t.base + match[0].length, scope),
            bound = new Set(scope);
          bound.add(name);
          if (index) bound.add(index);
          const content = sequence(depth + 1, true, bound);
          let otherwise: ReturnType<typeof sequence> | undefined;
          if (each && content.stop === 'else') otherwise = sequence(depth + 1, true, scope);
          if ((otherwise ?? content).stop !== (each ? 'endeach' : 'endlet'))
            fail(each ? 'PROMPT_MISSING_ENDEACH' : 'PROMPT_MISSING_ENDLET', t.start);
          if (each)
            add({
              kind: 'each',
              source: value,
              as: name,
              ...(index ? { index } : {}),
              body: content.nodes,
              ...(otherwise ? { else: otherwise.nodes } : {}),
            });
          else add({ kind: 'let', name, value, body: content.nodes });
          continue;
        }
        const match = /^\s*(if_trim_false|if_trim|if|text)\s+/u.exec(t.body);
        if (!match) fail('PROMPT_UNKNOWN_DIRECTIVE', t.start);
        const rest = t.body.slice(match![0].length),
          base = t.base + match![0].length;
        if (match![1] === 'text') {
          const ts = tokens(rest, base);
          if (ts.length !== 2 || ts[0].text !== 'string')
            fail('PROMPT_TEXT_LITERAL_REQUIRED', base);
          add({ kind: 'text', text: ts[0].value! });
        } else {
          const condition = expression(rest, base, scope),
            yes = sequence(depth + 1, true, scope);
          let no: ReturnType<typeof sequence> | undefined;
          if (yes.stop === 'else') no = sequence(depth + 1, true, scope);
          if ((no ?? yes).stop !== 'endif') fail('PROMPT_MISSING_ENDIF', t.start);
          add({
            kind: 'if',
            condition,
            then: yes.nodes,
            ...(no ? { else: no.nodes } : {}),
            ...(match![1] === 'if' ? {} : { trimLines: match![1] === 'if_trim' }),
          });
        }
      }
    }
    return { nodes };
  }
  return sequence(0, false).nodes;
}

/** Canonical source preserves AST shape, literal delimiters, and imported trim behavior. */
export function printPromptTemplate(template: PromptTemplate): string {
  let count = 0;
  const quoted = (value: RuntimeValue): string =>
    JSON.stringify(validateRuntimeValue(value, { maxValueChars: MAX_SOURCE }));
  function* expr(e: PromptExpression, depth = 0): Generator<string> {
    if (depth > MAX_DEPTH) throw new Error('PROMPT_NESTING_LIMIT');
    if (e === null || typeof e !== 'object') {
      yield quoted(e);
      return;
    }
    if ('control' in e) {
      yield /^[A-Za-z_][A-Za-z_0-9]*$/u.test(e.control)
        ? `options.${e.control}`
        : `options[${quoted(e.control)}]`;
      return;
    }
    if ('context' in e) {
      yield 'context';
      for (const part of e.context) yield `[${quoted(part)}]`;
      return;
    }
    if ('local' in e) {
      if (e.path && e.path.length === 0) {
        yield `localPath(${quoted(e.local)}, [])`;
        return;
      }
      yield `local[${quoted(e.local)}]`;
      for (const part of e.path ?? []) yield `[${quoted(part)}]`;
      return;
    }
    if ('literal' in e) {
      yield 'literal(';
      yield quoted(e.literal);
      yield ')';
      return;
    }
    if (e.args.length > 100) throw new Error('PROMPT_ARGUMENT_LIMIT');
    if (e.op === 'map' || e.op === 'filter') {
      yield `${e.op}${e.index ? 'Indexed' : ''}(`;
      yield* expr(e.args[0], depth + 1);
      yield `, ${quoted(e.as!)}, `;
      if (e.index) yield `${quoted(e.index)}, `;
      yield* expr(e.args[1], depth + 1);
      yield ')';
      return;
    }
    yield e.op + '(';
    for (let i = 0; i < e.args.length; i++) {
      if (i) yield ', ';
      yield* expr(e.args[i], depth + 1);
    }
    yield ')';
  }
  function* render(nodes: PromptTemplate, depth = 0): Generator<string> {
    if (depth > MAX_DEPTH) throw new Error('PROMPT_NESTING_LIMIT');
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (++count > MAX_NODES) throw new Error('PROMPT_NODE_LIMIT');
      if (n.kind === 'text') {
        if (
          !n.text ||
          /\{[{%]|\{$/u.test(n.text) ||
          nodes[i - 1]?.kind === 'text' ||
          nodes[i + 1]?.kind === 'text'
        ) {
          yield '{% text ';
          yield quoted(n.text);
          yield ' %}';
        } else yield n.text;
        continue;
      }
      if (n.kind === 'value') {
        yield '{{ ';
        yield* expr(n.expression);
        yield ' }}';
        continue;
      }
      if (n.kind === 'slot') {
        yield '{{ slot(';
        yield quoted(n.name);
        yield ') }}';
        continue;
      }
      if (n.kind === 'let') {
        yield `{% let ${n.name} = `;
        yield* expr(n.value);
        yield ' %}';
        yield* render(n.body, depth + 1);
        yield '{% endlet %}';
        continue;
      }
      if (n.kind === 'each') {
        yield `{% each ${n.as}${n.index ? ', ' + n.index : ''} in `;
        yield* expr(n.source);
        yield ' %}';
        yield* render(n.body, depth + 1);
        if (n.else !== undefined) {
          yield '{% else %}';
          yield* render(n.else, depth + 1);
        }
        yield '{% endeach %}';
        continue;
      }
      yield `{% ${n.trimLines === undefined ? 'if' : n.trimLines ? 'if_trim' : 'if_trim_false'} `;
      yield* expr(n.condition);
      yield ' %}';
      yield* render(n.then, depth + 1);
      if (n.else !== undefined) {
        yield '{% else %}';
        yield* render(n.else, depth + 1);
      }
      yield '{% endif %}';
    }
  }
  const parts: string[] = [];
  let length = 0;
  for (const part of render(template)) {
    length += part.length;
    if (length > MAX_SOURCE) throw new Error('PROMPT_SOURCE_LIMIT');
    parts.push(part);
  }
  return parts.join('');
}
