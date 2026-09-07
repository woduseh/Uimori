import { describe, expect, test } from 'vitest';
import { convertPhemePreset, parsePhemeTemplate } from '../core/pheme-converter.js';
import { compilePromptProgram, type PromptProgram, type PromptValue } from '../core/prompt-program.js';

const sourceHash = 'a'.repeat(64);
const toggles = 'pheme_mode=Mode=select=Story,Task\npheme_flag=Flag\npheme_text=Text=textarea';
const fixture = (promptTemplate: unknown[]) => ({ promptTemplate, customPromptTemplateToggle: toggles, templateDefaultVariables: 'pheme_mode=1', promptSettings: { assistantPrefill: '', sendChatAsSystem: false }, model: 'must-not-import', apiKey: 'must-not-import' });
const history = [{ id: 'first', role: 'assistant' as const, text: 'Greeting' }, { id: 'older', role: 'user' as const, text: 'Earlier' }, { id: 'answer', role: 'assistant' as const, text: 'Answer' }, { id: 'now', role: 'user' as const, text: 'Current', current: true }];
function compile(source: string, values: Record<string, PromptValue> = {}, slots: Record<string, string> = {}) {
  const converted = convertPhemePreset(fixture([
    { id: 'body', name: 'Body', type: 'plain', type2: 'normal', role: 'system', text: source },
    { id: 'history', type: 'chat', rangeStart: 0, rangeEnd: 'end' },
  ]), { sourceHash, variant: 'normal' });
  return compilePromptProgram(converted.program, { history, values, slots });
}
describe('Phēmē structural conversion', () => {
  test('records absent global toggles separately from a suggested native combination', () => {
    const result = convertPhemePreset(fixture([]), { sourceHash, variant: 'normal' });
    expect(result.program.controls.map(c => c.default)).toEqual([null, null, null]);
    expect(result.declaredTemplateDefaults).toEqual({ pheme_mode: '1' });
    expect(result.suggestedCombination.values).toEqual({ pheme_mode: '1', pheme_flag: false, pheme_text: '' });
    expect(JSON.stringify(result.program)).not.toContain('must-not-import');
    expect(compile('{{getglobalvar::toggle_pheme_text}}').messages[0]!.content[0]!.text).toBe('null');
  });
  test('converts nested typed conditions and strict scalar boolean semantics', () => {
    const source = '{{#when::pheme_mode::tis::1}}T{{#when::toggle::pheme_flag}}Y{{:else}}N{{/when}}{{:else}}S{{/when}}';
    expect(compile(source, { pheme_mode: '1', pheme_flag: true }).messages[0]!.content[0]!.text).toBe('TY');
    expect(compile(source, { pheme_mode: '1', pheme_flag: false }).messages[0]!.content[0]!.text).toBe('TN');
    expect(compile('{{#when::{{any::{{getglobalvar::toggle_pheme_text}}::0}}}}Y{{:else}}N{{/when}}', { pheme_text: 'true' }).messages[0]!.content[0]!.text).toBe('N');
    expect(compile('{{#when::{{getglobalvar::toggle_pheme_text}}}}Y{{:else}}N{{/when}}', { pheme_text: 'true' }).messages[0]!.content[0]!.text).toBe('Y');
  });
  test('preserves inline spaces and removes only outer blank lines in multiline conditions', () => {
    expect(compile('a{{#when::1}} x {{/when}}z').messages[0]!.content[0]!.text).toBe('a x z');
    expect(compile('a{{#when::1}}\n  \n x \n\n{{/when}}z').messages[0]!.content[0]!.text).toBe('a x z');
    expect(compile('{{#when::1}}\n{{#when::0}}discard{{/when}}\nkept\n{{/when}}').messages[0]!.content[0]!.text).toBe('kept');
  });
  test('nested replace/length/numeric operations use source string semantics', () => {
    const source = '{{#when::{{and::{{notequal::{{getglobalvar::toggle_pheme_text}}::null}}::{{greaterequal::{{length::{{replace::{{getglobalvar::toggle_pheme_text}}::a::}}}}::2}}}}}}Y{{:else}}N{{/when}}';
    expect(compile(source, { pheme_text: 'a12' }).messages[0]!.content[0]!.text).toBe('Y');
    expect(compile(source, { pheme_text: 'a1' }).messages[0]!.content[0]!.text).toBe('N');
    expect(compile('{{greaterequal::{{getglobalvar::toggle_pheme_text}}::0}}').messages[0]!.content[0]!.text).toBe('0');
  });
  test('slot and character values are inserted without executing their contents', () => {
    const result = convertPhemePreset(fixture([
      { id: 'persona', type: 'persona', role2: 'system', innerFormat: '{{char}}:[{{slot}}]' },
      { id: 'history', type: 'chat', rangeStart: 0, rangeEnd: 'end' },
    ]), { sourceHash, variant: 'normal' });
    const slots = { char: '{{getglobalvar::toggle_pheme_text}}', persona: '{{#when::1}}raw{{/when}}' };
    const out = compilePromptProgram(result.program, { history, slots });
    expect(out.messages[0]!.content[0]!.text).toBe(`${slots.char}:[${slots.persona}]`);
    expect(compilePromptProgram(result.program, { history, slots: { ...slots, persona: '' } }).messages.map(m => m.provenance.origin)).not.toContain('prompt');
  });
  test('preserves role order, current history once, and matching-role cache depth', () => {
    const result = convertPhemePreset(fixture([
      { id: 'receipt', type: 'plain', type2: 'normal', role: 'bot', text: 'Receipt' },
      { id: 'past', type: 'chat', rangeStart: 0, rangeEnd: -2 },
      { id: 'anchor', type: 'cache', depth: 2, role: 'user' },
      { id: 'seal', type: 'plain', type2: 'normal', role: 'system', text: 'Seal' },
      { id: 'recent', type: 'chat', rangeStart: -2, rangeEnd: 'end' },
    ]), { sourceHash, variant: 'tool-call' });
    const out = compilePromptProgram(result.program, { history, slots: {} });
    expect(out.messages.map(m => m.role)).toEqual(['assistant', 'assistant', 'user', 'system', 'assistant', 'user']);
    expect(out.messages.filter(m => m.provenance.origin === 'current')).toHaveLength(1);
    expect(out.cachePlan).toEqual([{ blockId: 'anchor', afterMessageId: 'past:older', policy: 'prefer' }]);
    expect(out.messages[0]!.completion).toBe('complete');
    expect(out.trace.find(t => t.blockId === 'anchor')!.messageIds).toEqual([]);
  });
  test('rejects unsupported expressions and malformed block grammar without returning source content', () => {
    for (const source of ['{{setvar::secret::content}}', '{{#when::1}}x', '{{:else}}', '{{#when::1}}a{{:else}}b{{:else}}c{{/when}}', '{{getglobalvar::other}}', '{{getglobalvar::toggle_unknown}}']) {
      expect(() => parsePhemeTemplate(source, ['pheme_flag'])).toThrow(/PHEME_/);
    }
    expect(() => parsePhemeTemplate('{{getglobalvar::private-secret}}', [])).toThrow('PHEME_GLOBAL_REFERENCE_UNSUPPORTED');
  });
  test('rejects unsupported role, source item behavior, and nonempty prefill', () => {
    expect(() => convertPhemePreset(fixture([{ id: 'x', type: 'lua', text: 'irrelevant' }]), { sourceHash, variant: 'normal' })).toThrow('PHEME_ITEM_TYPE_UNSUPPORTED');
    expect(() => convertPhemePreset(fixture([{ id: 'x', type: 'plain', type2: 'normal', role: 'tool', text: 'irrelevant' }]), { sourceHash, variant: 'normal' })).toThrow('PHEME_ROLE_UNSUPPORTED');
    const raw = fixture([]); raw.promptSettings.assistantPrefill = 'not-supported';
    expect(() => convertPhemePreset(raw, { sourceHash, variant: 'normal' })).toThrow('PHEME_SETTINGS_UNSUPPORTED');
  });
});
