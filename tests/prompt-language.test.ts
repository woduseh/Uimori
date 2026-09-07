import { describe, expect, it } from 'vitest';
import { parsePromptTemplate, printPromptTemplate, PromptLanguageError } from '../core/prompt-language.js';
import { compilePromptProgram, evaluatePromptExpression, type PromptExpression, type PromptTemplate } from '../core/prompt-program.js';

describe('authored prompt language', () => {
  it('parses namespaced controls, slots and conditions with precedence', () => {
    const nodes = parsePromptTemplate('Hi {{ bot.name }}{% if options.count >= 2 and not false %}yes{% else %}no{% endif %}', ['count']);
    expect(nodes[1]).toEqual({ kind: 'slot', name: 'bot.name' });
    const conditional = nodes[2]; expect(conditional.kind).toBe('if');
    if (conditional.kind === 'if') expect(evaluatePromptExpression(conditional.condition, { count: 3 })).toBe(true);
  });
  it.each(['==', '!=', '>', '>=', '<', '<='])('supports %s without JS', op => {
    const [node] = parsePromptTemplate(`{{ 2 ${op} 3 }}`, []);
    if (node.kind !== 'value') throw new Error('expected value');
    expect(evaluatePromptExpression(node.expression, {})).toBe(['!=', '<', '<='].includes(op));
  });
  it('handles quoted delimiters, escapes and fixed functions', () => {
    const [node] = parsePromptTemplate('{{ replace("}}\\n", "}}", \'{%\') }}', []);
    if (node.kind !== 'value') throw new Error('expected value');
    expect(evaluatePromptExpression(node.expression, {})).toBe('{%\n');
  });
  it.each(['{% else %}', '{% endif %}', '{% if true %}', '{% if true %}{% else %}{% else %}{% endif %}', '{{ options.missing }}', '{{ process.env }}', '{{ options.x.toString() }}', '{{ eval("1") }}', '{{ "bad\\q" }}', '{{ "open }}', '{{ 1e999 }}', '{{ length(1, 2) }}', '{{ true true }}'])('rejects malformed or unauthorized input: %s', source => {
    expect(() => parsePromptTemplate(source, ['x'])).toThrow(PromptLanguageError);
  });
  it('reports source positions', () => {
    try { parsePromptTemplate('line\n{{ options.missing }}', []); throw new Error('expected rejection'); }
    catch (error) { expect(error).toBeInstanceOf(PromptLanguageError); expect(error).toMatchObject({ code: 'PROMPT_UNKNOWN_CONTROL', line: 2, column: 4, offset: 8 }); }
  });
  it('roundtrips every native expression and template property', () => {
    const expressions: PromptExpression[] = [null, true, false, 2.5, 'literal }}', { control: 'legacy::id' }, ...(['all', 'any', 'not', 'equal', 'notEqual', 'greater', 'greaterEqual', 'length', 'replace'] as const).map(op => ({ op, args: op === 'all' || op === 'any' ? [] : op === 'not' || op === 'length' ? [true] : op === 'replace' ? ['abc', 'b', 'B'] : [1, 2] }))];
    const template: PromptTemplate = [{ kind: 'text', text: '' }, { kind: 'text', text: '{{ untrusted }}' }, { kind: 'text', text: 'adjacent' }, { kind: 'slot', name: 'legacy-slot' }, ...expressions.map(expression => ({ kind: 'value' as const, expression })), ...[undefined, false, true].map(trimLines => ({ kind: 'if' as const, condition: true, then: [], else: [], ...(trimLines === undefined ? {} : { trimLines }) }))];
    expect(parsePromptTemplate(printPromptTemplate(template), ['legacy::id'], ['legacy-slot'])).toEqual(template);
  });
  it('never reparses values, slots or chat input', () => {
    const template = parsePromptTemplate('{{ options.x }}{{ bot.name }}', ['x']);
    const result = compilePromptProgram({ version: 1, controls: [{ id: 'x', label: 'x', type: 'text', default: '{% if true %}injected' }], blocks: [{ id: 'p', title: 'p', kind: 'message', role: 'system', template }, { id: 'c', title: 'c', kind: 'current' }] }, { slots: { 'bot.name': '{{ options.secret }}' }, history: [{ id: 'h', role: 'user', text: '{% endif %}', current: true }] });
    expect(result.messages.map(m => m.content[0].text)).toEqual(['{% if true %}injected{{ options.secret }}', '{% endif %}']);
  });
  it('does not form delimiters across printed node boundaries', () => {
    const template: PromptTemplate = [{ kind: 'text', text: 'brace {' }, { kind: 'value', expression: true }];
    expect(parsePromptTemplate(printPromptTemplate(template), [])).toEqual(template);
  });
  it('enforces source, AST depth and node bounds', () => {
    for (const source of ['x'.repeat(200001), '{{ ' + '('.repeat(34) + 'true' + ')'.repeat(34) + ' }}', '{% if true %}'.repeat(34) + '{% endif %}'.repeat(34), '{{ ' + Array(1000).fill('true').join(' and ') + ' }}', '{{ true }}'.repeat(5001)]) expect(() => parsePromptTemplate(source, [])).toThrow(PromptLanguageError);
  });
});
