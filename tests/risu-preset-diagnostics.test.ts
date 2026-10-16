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
  it('preserves authored extra CR characters when comparing native option labels', () => {
    const before = program('mode=Mode=select=A\r\n');
    const after = program('mode=Mode=select=A\r\r\n');
    expect(diagnoseRisuPreset(after, {}, before).diagnostics).toMatchObject([
      {
        code: 'toggle_option_meaning_changed',
        option: { previousLabel: 'A', currentLabel: 'A\r' },
      },
    ]);
  });
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

  it('locates duplicate and invalid keys without guessing values for invalid declarations', () => {
    const source = program('a=First\r\na=Second\nbad\t=Bad');
    const result = diagnoseRisuPreset(source, { a: 'wrong', removed: '1' });
    expect(result.diagnostics).toEqual([
      {
        code: 'toggle_key_duplicate',
        severity: 'warning',
        message: expect.any(String),
        path: '/nativeRisuPreset/preset/customPromptTemplateToggle',
        range: { start: 9, end: 17, line: 2 },
        controlId: 'a',
      },
      {
        code: 'toggle_key_invalid',
        severity: 'warning',
        message: expect.any(String),
        path: '/nativeRisuPreset/preset/customPromptTemplateToggle',
        range: { start: 18, end: 26, line: 3 },
      },
    ]);
    expect(result.coverage.selectedValues).toBe('skipped_invalid_declarations');
    expect(diagnoseRisuPreset(program(['not', 'a declaration'])).diagnostics[0]?.code).toBe(
      'toggle_declaration_type'
    );
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

  it('detects same-index label changes that remain valid selections, without deciding their intent', () => {
    const previous = program('mode=Mode=select=Story,Notes');
    const current = program('mode=Renamed control=select=Notes,Story');
    const before = structuredClone({ previous, current });
    expect(diagnoseRisuPreset(current, { mode: '1' }).diagnostics).toEqual([]);
    const result = diagnoseRisuPreset(current, { mode: '1' }, previous);
    expect(result.coverage.optionChanges).toBe('checked');
    expect(result.diagnostics).toMatchObject([
      {
        code: 'toggle_option_meaning_changed',
        severity: 'warning',
        controlId: 'mode',
        option: { value: '0', previousLabel: 'Story', currentLabel: 'Notes' },
      },
      {
        code: 'toggle_option_meaning_changed',
        severity: 'warning',
        controlId: 'mode',
        option: { value: '1', previousLabel: 'Notes', currentLabel: 'Story' },
      },
    ]);
    expect({ previous, current }).toEqual(before);
    expect(diagnoseRisuPreset(previous, { mode: '1' }, previous).diagnostics).toEqual([]);
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

  it('leaves CBS source untouched and explicitly excludes syntax, comparisons and variable analysis', () => {
    // Pinned Risu supports raw/pure blocks, escapes, nested dynamic names, comments and source
    // reparsing. None of these are evidence of an invalid declaration or selected option.
    const text = [
      '{{// {{#when::mode::tis::99}} }}',
      '{{#pure}}{{#when::mode::tis::99}}raw{{/when}}{{/pure}}',
      '{{#puredisplay}}{{getvar::missing}}{{/puredisplay}}',
      '{{#escape}}{{setvar::state::changed}}{{/escape}}',
      '\uE9B8\uE9B8getvar::escaped\uE9B9\uE9B9',
      '{{getvar::{{getvar::dynamicName}}}}',
      '{{#when::mode::tis::99}}text{{/differentName}}',
      '{{setvar::state::changed}} {{getvar::unfinished',
    ].join('\n');
    const source = program('mode=Mode=select=First,Second', text);
    const before = structuredClone(source);
    const result = diagnoseRisuPreset(source);
    expect(result.diagnostics).toEqual([]);
    expect(result.coverage).toMatchObject({
      cbsSyntax: false,
      cbsComparisons: false,
      variables: false,
    });
    expect(result.coverage.limitations.length).toBeGreaterThan(0);
    expect(source).toEqual(before);
  });

  it('bounds report size and label previews while retaining the complete diagnostic count', () => {
    const previous = program(`mode=Mode=select=${'old'.repeat(1000)}`);
    const current = program(`mode=Mode=select=${'new'.repeat(1000)}`);
    const preview = diagnoseRisuPreset(current, {}, previous).diagnostics[0]?.option;
    expect(preview?.previousLabel).toHaveLength(160);
    expect(preview?.currentLabel).toHaveLength(160);
    const values = Object.fromEntries(
      Array.from({ length: 205 }, (_, index) => [`old${index}`, '0'])
    );
    values['x'.repeat(10_000)] = '0';
    const result = diagnoseRisuPreset(program(''), values);
    expect(result.diagnostics).toHaveLength(200);
    expect(result.totalDiagnostics).toBe(206);
    expect(result.truncated).toBe(true);
    expect(
      diagnoseRisuPreset(program(''), { ['x'.repeat(10_000)]: '0' }).diagnostics[0]
    ).toMatchObject({
      path: '/values',
    });
    expect(
      diagnoseRisuPreset(program(''), { ['x'.repeat(10_000)]: '0' }).diagnostics[0]
    ).not.toHaveProperty('controlId');
  });
});
