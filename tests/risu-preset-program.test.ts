import { describe, expect, it } from 'vitest';
import { compilePromptProgram, validateEditablePromptProgram } from '../core/prompt-program.js';
import { importRisuPresetProgram } from '../server/risu-preset-program.js';

const preset = (text: string, extra: Record<string, unknown> = {}) => ({
  name: 'Independent synthetic preset',
  customPromptTemplateToggle: 'mode=Mode=select=First,Second\nflag=Flag\ncustom=Custom=text',
  promptTemplate: [
    { type: 'plain', type2: 'normal', role: 'system', text },
    { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
  ],
  ...extra,
});
const render = (input: unknown, values: Record<string, string | null> = {}) => {
  const converted = importRisuPresetProgram(input);
  const result = compilePromptProgram(converted.program, {
    values,
    slots: {
      char: 'Character',
      slot: '',
      persona: 'PROFILE',
      description: 'DESCRIPTION',
      authorNote: 'NOTE',
      globalNote: 'GLOBAL',
      lorebook: 'LORE',
      postEverything: 'POST',
    },
    history: [{ id: 'current', role: 'user', text: 'CURRENT', current: true }],
  });
  return {
    converted,
    text: result.messages
      .filter((message) => message.provenance.origin !== 'current')
      .map((message) => message.content[0].text)
      .join('\n'),
  };
};

describe('Risu preset program conversion', () => {
  it('keeps unset global toggles separate from option zero and chat variable defaults', () => {
    const input = preset('{{#when::mode::tis::0}}zero{{:else}}other{{/when}}', {
      templateDefaultVariables: 'mode=0',
    });
    const unset = render(input);
    expect(unset.text).toBe('other');
    expect(unset.converted.program.controls.map((control) => control.default)).toEqual([
      null,
      null,
      null,
    ]);
    expect(render(input, { mode: '0' }).text).toBe('zero');
    expect(() => validateEditablePromptProgram(unset.converted.program)).not.toThrow();
  });

  it('maps nested conditions and computed string expressions without flattening them', () => {
    const input = preset(
      '{{#when::{{and::{{notequal::{{getglobalvar::toggle_custom}}::null}}::{{greater::{{length::{{getglobalvar::toggle_custom}}}}::0}}}}}}\nHello {{char}}: {{replace::{{getglobalvar::toggle_custom}}::,::}}\n{{:else}}\nempty\n{{/when}}'
    );
    expect(render(input).text).toBe('empty');
    expect(render(input, { custom: '1,500' }).text).toBe('Hello Character: 1500');
  });

  it('uses exact CBS truth values rather than general nonempty string truth', () => {
    const input = preset(
      '{{#when::{{getglobalvar::toggle_custom}}}}yes{{:else}}no{{/when}}|{{and::true::1}}|{{any::2::1}}'
    );
    expect(render(input, { custom: 'arbitrary' }).text).toBe('no|0|1');
    expect(render(input, { custom: 'true' }).text).toBe('yes|0|1');
  });

  it('preserves nested else branches, whitespace mode, and first option string indices', () => {
    const input = preset(
      '{{#when::mode::tisnot::1}}\n  outer\n{{#when::toggle::flag}}\n  on\n{{:else}}\n  off\n{{/when}}\n{{/when}}|{{#when::keep::1}}\n x \n{{/when}}'
    );
    expect(render(input, { mode: '0', flag: '1' }).text).toBe('  outer\n  on|\n x \n');
  });

  it('preserves prompt order, message roles, slot templates, history slicing, and cache placement', () => {
    const converted = importRisuPresetProgram(
      preset('', {
        promptTemplate: [
          { type: 'persona', role2: 'user', innerFormat: '<p>{{slot}}</p>' },
          { type: 'chat', rangeStart: 0, rangeEnd: -1 },
          { type: 'cache', role: 'all', depth: 1 },
          { type: 'plain', role: 'bot', text: 'ack' },
          { type: 'chat', rangeStart: -1, rangeEnd: 'end' },
        ],
      })
    );
    const compiled = compilePromptProgram(converted.program, {
      slots: { persona: 'PROFILE' },
      history: [
        { id: 'old', role: 'assistant', text: 'old' },
        { id: 'new', role: 'user', text: 'new', current: true },
      ],
    });
    expect(compiled.messages.map((message) => [message.role, message.content[0].text])).toEqual([
      ['user', '<p>PROFILE</p>'],
      ['assistant', 'old'],
      ['assistant', 'ack'],
      ['user', 'new'],
    ]);
    expect(compiled.cachePlan).toHaveLength(1);
  });

  it.each([
    '{{setvar::counter::1}}',
    '{{setdefaultvar::counter::1}}',
    '{{unknown::x}}',
    '{{#when::1}}unclosed',
  ])('disables unsupported CBS and never sends it as active prompt text: %s', (text) => {
    const { converted, text: output } = render(preset(text));
    expect(output).toBe('');
    expect(converted.program.blocks[0].enabled).toBe(false);
    expect(converted.findings.some((finding) => finding.level === 'unsupported')).toBe(true);
  });

  it('keeps the text of an unsupported block inside the disabled block for repair', () => {
    const source = '{{setvar::counter::1}} keep me';
    const { converted, text } = render(preset(source));
    expect(text).toBe('');
    expect(converted.program.blocks[0]).toMatchObject({
      enabled: false,
      template: [{ kind: 'text', text: source }],
    });
    expect(
      converted.findings.find((finding) => finding.code === 'RISU_PRESET_BLOCK_UNSUPPORTED')
        ?.message
    ).toContain('꺼진 블록');
  });

  it('does not disguise Risu memory as native notes or enable model connections', () => {
    const converted = importRisuPresetProgram(
      preset('', {
        aiModel: 'external-model',
        promptTemplate: [{ type: 'memory', innerFormat: '{{slot}}' }],
      })
    );
    expect(converted.program.blocks[0].enabled).toBe(false);
    expect(converted.program).not.toHaveProperty('aiModel');
  });
});
