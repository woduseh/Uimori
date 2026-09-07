import { describe, expect, it } from 'vitest';
import { assistant, cache, choose, current, definePrompt, expr, history, option, slot, slotText, system, text, user, when } from '../core/prompt-authoring.js';
import { compilePromptProgram, type PromptProgram } from '../core/prompt-program.js';

const compile = (program: PromptProgram, values: Record<string, string | number | boolean | null>) => compilePromptProgram(program, { values, slots: { description: 'Synthetic bot', persona: '{{ options.notCode }}' }, history: [{ id: 'old', role: 'assistant', text: 'Old text' }, { id: 'now', role: 'user', text: '{% if unknown %}', current: true }] });
describe('trusted TypeScript prompt authoring', () => {
  it('executes authoring once and reuses a data artifact with different runtime options', () => {
    let calls = 0;
    const program = definePrompt({ controls: { detailed: option.boolean({ label: 'Detailed', default: false }), count: option.number({ label: 'Count', default: 1, min: 0, max: 5 }) }, compose: ({ options }) => {
      calls++;
      return [system('intro', text`Level ${options.count}. ${choose(options.detailed, 'Detailed', 'Brief')}`), when(expr.greaterEqual(options.count, 2), system('extra', 'Extra instruction')), history()];
    } });
    expect(compile(program, { count: 1 }).messages[0].content[0].text).toBe('Level 1. Brief');
    const result = compile(program, { count: 3, detailed: true }); expect(result.messages[0].content[0].text).toBe('Level 3. Detailed'); expect(result.messages[1].content[0].text).toBe('Extra instruction'); expect(calls).toBe(1);
    expect(JSON.parse(JSON.stringify(program))).toEqual(program);
  });
  it('builds role, history, slot, cache and prefill contracts without reparsing data', () => {
    const program = definePrompt({ controls: {}, compose: () => [system('literal', text`Literal {{ keep }} ${slotText('persona')}`), slot('bot', 'description', { template: text`Bot: ${slotText('slot')}` }), user('example', 'Synthetic question'), assistant('answer', 'Synthetic answer'), history('prior', 0, -1), current(), cache('anchor'), assistant('prefill', 'Next:', { completion: 'prefill' })] });
    const result = compile(program, {}); expect(result.messages.map(m => m.role)).toEqual(['system', 'system', 'user', 'assistant', 'assistant', 'user', 'assistant']); expect(result.messages[0].content[0].text).toBe('Literal {{ keep }} {{ options.notCode }}'); expect(result.messages[1].content[0].text).toBe('Bot: Synthetic bot'); expect(result.messages[5].content[0].text).toBe('{% if unknown %}'); expect(result.cachePlan).toHaveLength(1); expect(result.messages.at(-1)?.completion).toBe('prefill');
  });
  it('retains existing conditions when a reusable block is wrapped again', () => {
    const program = definePrompt({ controls: { a: option.boolean({ label: 'A', default: false }), b: option.boolean({ label: 'B', default: true }) }, compose: ({ options }) => [when(options.b, when(options.a, system('both', 'Both'))), history()] });
    expect(compile(program, {}).trace[0].included).toBe(false); expect(compile(program, { a: true }).trace[0].included).toBe(true);
  });
  it('supports typed enum options and fixed string operations', () => {
    const program = definePrompt({ controls: { tone: option.select({ label: 'Tone', options: [{ label: 'Calm', value: 'calm' }, { label: 'Bright', value: 'bright' }], default: 'calm' }), note: option.text({ label: 'Note', default: 'abc' }) }, compose: ({ options }) => [system('values', text`${expr.replace(options.note, 'b', 'B')}:${expr.length(options.note)}:${choose(expr.equal(options.tone, 'calm'), 'quiet', 'active')}`), history()] });
    expect(compile(program, {}).messages[0].content[0].text).toBe('aBc:3:quiet'); expect(() => compile(program, { tone: 'unsupported' })).toThrow('PROMPT_INVALID_CONTROL_VALUE');
  });
  it('validates authoring output and returns a detached snapshot', () => {
    const shared = system('same', 'Original'); const program = definePrompt({ controls: {}, compose: () => [shared, history()] }); shared.title = 'Changed'; expect(program.blocks[0].title).toBe('same');
    expect(() => definePrompt({ controls: {}, compose: () => [shared, shared] })).toThrow('PROMPT_DUPLICATE_BLOCK');
    expect(() => definePrompt({ controls: {}, compose: () => [system('large', 'x'.repeat(200001))] })).toThrow('PROMPT_INVALID_STRING');
    expect(() => definePrompt({ controls: { count: option.number({ label: 'Count', default: 20, max: 3 }) }, compose: () => [] })).toThrow('PROMPT_INVALID_CONTROL_VALUE');
    expect(() => definePrompt({ controls: {}, compose: () => [system('unknown', [{ kind: 'value', expression: { control: 'undeclared' } }])] })).toThrow('PROMPT_UNKNOWN_CONTROL');
  });
  it('applies ordinary JavaScript decisions only while creating the artifact', () => {
    let authoringFlag = true;
    const program = definePrompt({ controls: {}, compose: () => [...(authoringFlag ? [system('authoring', 'Included once')] : []), history()] }); authoringFlag = false;
    expect(compile(program, {}).messages[0].content[0].text).toBe('Included once');
  });
});

// Checked by npm run check; this is never invoked at runtime.
function typeContracts() {
  definePrompt({ controls: { count: option.number({ label: 'Count', default: 1 }), tone: option.select({ label: 'Tone', options: [{ label: 'Calm', value: 'calm' }], default: 'calm' }) }, compose: ({ options }) => {
    // @ts-expect-error unknown options do not belong to this prompt
    expr.literal(options.unknown);
    // @ts-expect-error numeric comparison does not accept string expressions
    expr.greater(options.tone, 2);
    // @ts-expect-error enum spelling is checked
    expr.equal(options.tone, 'bright');
    // @ts-expect-error a number expression is not a boolean runtime condition
    when(options.count, system('bad', 'bad'));
    return [history()];
  } });
}
void typeContracts;
