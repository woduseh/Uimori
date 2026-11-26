import { describe, expect, it } from 'vitest';
import { createNativeRisuPresetProgram } from '../core/risu-native-preset.js';
import { diagnoseRisuPreset } from '../core/risu-preset-diagnostics.js';
import type { PromptValue } from '../core/risu-prompt.js';

const program = (declaration: unknown, text = '') =>
  createNativeRisuPresetProgram({
    version: 1,
    preset: {
      customPromptTemplateToggle: declaration,
      promptTemplate: [{ type: 'plain', role: 'system', text }],
    },
  });

describe('read-only native preset diagnostics', () => {
  it('uses native declaration and selection semantics, including empty options, aliases and defaults', () => {
    const source = program(
      [
        '=Settings=group',
        'mode=Mode=select=,First,,',
        'name=Name=text',
        'notes=Notes=textarea',
        'legacy=Legacy=unknown',
        '__proto__=Reserved',
        'risu-toggle:custom=Aliased',
        '=Description=caption',
        '==groupEnd',
        'opaque source',
      ].join('\r\n')
    );
    expect(
      diagnoseRisuPreset(source, {
        mode: '3',
        name: null,
        notes: '{{getvar::card_state}}',
        legacy: '1',
        'risu-toggle:__proto__': '1',
        'risu-toggle:risu-toggle%3Acustom': '0',
      })
    ).toMatchObject({
      diagnostics: [],
      totalDiagnostics: 0,
      truncated: false,
      coverage: { selectedValues: 'checked', optionChanges: 'not_provided' },
    });
  });

  it('reports actual reset candidates but never resets or saves the supplied selections', () => {
    const source = program('mode=Mode=select=First,Second\nname=Name=text\nswitch=Switch');
    const values: Record<string, PromptValue> = {
      mode: 1,
      name: false,
      switch: '2',
      'old/key~': '1',
    };
    const before = structuredClone({ source, values });
    const result = diagnoseRisuPreset(source, values);
    expect(
      result.diagnostics.map(({ code, path, controlId }) => ({ code, path, controlId }))
    ).toEqual([
      { code: 'toggle_value_unknown', path: '/values/old~1key~0', controlId: 'old/key~' },
      { code: 'toggle_value_invalid', path: '/values/mode', controlId: 'mode' },
      { code: 'toggle_value_invalid', path: '/values/name', controlId: 'name' },
      { code: 'toggle_value_invalid', path: '/values/switch', controlId: 'switch' },
    ]);
    expect({ source, values }).toEqual(before);
    expect(result).not.toHaveProperty('values');
    expect(
      diagnoseRisuPreset(source, { mode: null, name: null, switch: null }).diagnostics
    ).toEqual([]);
  });

  it('distinguishes removed selected choices from unselected choices and handles unavailable comparisons', () => {
    const previous = program(
      'mode=Mode=select=First,Second,Third\nretired=Retired\nname=Name=text'
    );
    const current = program('mode=Mode=select=First\nname=Name');
    const result = diagnoseRisuPreset(current, { mode: '2' }, previous);
    expect(
      result.diagnostics.filter((entry) => entry.code === 'toggle_option_removed')
    ).toMatchObject([
      { severity: 'info', option: { value: '1', previousLabel: 'Second' } },
      { severity: 'warning', option: { value: '2', previousLabel: 'Third' } },
    ]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'toggle_value_invalid', controlId: 'mode' }),
        expect.objectContaining({ code: 'toggle_removed', controlId: 'retired' }),
        expect.objectContaining({ code: 'toggle_type_changed', controlId: 'name' }),
      ])
    );
    const invalid = program('a=First\na=Second');
    expect(diagnoseRisuPreset(current, {}, invalid).coverage.optionChanges).toBe(
      'skipped_invalid_previous_declarations'
    );
    expect(diagnoseRisuPreset(invalid, {}, previous).coverage.optionChanges).toBe(
      'skipped_invalid_declarations'
    );
  });
});
