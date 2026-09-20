import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  compileRisuPrompt,
  promptControls,
  resolvePromptValues,
  reconcilePromptValues,
  validateRisuPrompt,
} from '../core/risu-prompt.js';
import {
  createNativeRisuPresetProgram,
  evaluatedNativeRisuPreset,
  nativeRisuPresetFields,
} from '../core/risu-native-preset.js';
import { evaluateNativeRisuFields } from '../server/risu-native-cbs.js';
import pheme from '../server/builtin-prompts/pheme.json' with { type: 'json' };
import defaults from '../server/builtin-prompts/pheme-options.json' with { type: 'json' };

const slots = {
  description: 'Character description',
  persona: 'Player persona',
  lorebook: 'Relevant lore',
  globalNote: 'Global note',
  authorNote: 'Author note',
  postEverything: 'Last instruction',
};
const history = [
  { id: 'previous', role: 'assistant' as const, text: 'Previous story' },
  { id: 'current', role: 'user' as const, text: 'Continue', current: true },
];

describe('native Risu prompt composition', () => {
  test('uses original block roles, slot wrappers, history ranges and cache anchors without AST projection', () => {
    const program = createNativeRisuPresetProgram({
      version: 1,
      preset: {
        promptTemplate: [
          { type: 'plain', role: 'system', text: 'Instruction' },
          { type: 'description', role2: 'user', innerFormat: '<character>{{slot}}</character>' },
          { type: 'chat', rangeStart: 0, rangeEnd: -1 },
          { type: 'cache', role: 'all', depth: 1 },
          { type: 'chat', rangeStart: -1, rangeEnd: 'end' },
        ],
        promptSettings: { assistantPrefill: 'Opening' },
      },
    });
    const result = compileRisuPrompt(program, { slots, history });
    expect(result.messages.map((m) => [m.role, m.content[0].text])).toEqual([
      ['system', 'Instruction'],
      ['user', '<character>Character description</character>'],
      ['assistant', 'Previous story'],
      ['user', 'Continue'],
    ]);
    expect(result.cachePlan).toEqual([
      { blockId: 'risu-block-4', afterMessageId: 'risu-block-3:previous', policy: 'prefer' },
    ]);
    expect(result.messages.every((message) => message.completion === 'complete')).toBe(true);
    expect(result.usedSlots).toEqual(['description']);
    expect(program).not.toHaveProperty('blocks');
    expect(program).not.toHaveProperty('controls');
  });
  test('rejects alternate authored AST and preserves native toggle strings', () => {
    expect(() => validateRisuPrompt({ version: 1, controls: [], blocks: [] })).toThrow();
    const program = createNativeRisuPresetProgram({
      version: 1,
      preset: {
        promptTemplate: [],
        customPromptTemplateToggle: 'mode=Mode=select=Story,Notes\nname=Name=text',
      },
    });
    expect(promptControls(program)).toMatchObject([
      { id: 'mode', default: '0', options: [{ value: '0' }, { value: '1' }] },
      { id: 'name', type: 'text', default: '' },
    ]);
    expect(resolvePromptValues(program)).toEqual({ mode: '0', name: '' });
    expect(resolvePromptValues(program, { mode: null, name: null })).toEqual({
      mode: '0',
      name: '',
    });
    expect(reconcilePromptValues(program, { mode: null, name: null })).toEqual({
      values: { mode: '0', name: '' },
      resetKeys: [],
    });
    expect(() => validateRisuPrompt({ ...program, transforms: [] })).toThrow();
    program.nativeRisuPreset.preset.customPromptTemplateToggle += '\ntoString=Named toggle';
    expect(resolvePromptValues(program).toString).toBe('0');
  });
  test.each(['0', '1', '2'].flatMap((mode) => ['0', '1'].map((botType) => [mode, botType])))(
    'bundled Phēmē source executes native CBS with session mode %s and bot type %s',
    async (mode, botType) => {
      const selectedValues = { ...defaults, pheme_session_mode: mode, pheme_bot_type: botType };
      const program = validateRisuPrompt(pheme),
        source = program.nativeRisuPreset;
      const before = JSON.stringify(program);
      const fields = await evaluateNativeRisuFields({
        native: {
          version: 1,
          sourceHash: createHash('sha256').update(before).digest('hex'),
          assets: [],
          card: { name: 'Character', extensions: { risuai: {} } },
        },
        fields: nativeRisuPresetFields(source),
        context: {
          variables: {},
          globalVariables: Object.fromEntries(
            Object.entries(selectedValues).map(([k, v]) => [
              `toggle_${k}`,
              v === null ? 'null' : String(v),
            ])
          ),
          charName: 'Character',
          userName: 'Player',
          messages: [],
        },
      });
      expect(fields.issues.filter((issue) => issue !== 'slot')).toEqual([]);
      const result = compileRisuPrompt(
        { ...program, nativeRisuPreset: evaluatedNativeRisuPreset(source, fields.fields) },
        { slots, history, values: selectedValues }
      );
      const text = result.messages.flatMap((m) => m.content.map((p) => p.text)).join('\n');
      expect(text).toContain('Phēmē');
      expect(text).toContain('Character description');
      expect(text).not.toMatch(/\{\{/u);
      expect(text.match(/Character description/gu)).toHaveLength(1);
      const wrappers = [
        '<character primary_ai_authored="true">',
        '<roleplay_setting>',
        '<session_reference purpose="ooc_source_material">',
      ];
      const selectedWrapper = wrappers[mode === '2' ? 2 : Number(botType)]!;
      expect(text).toContain(selectedWrapper);
      for (const wrapper of wrappers.filter((item) => item !== selectedWrapper))
        expect(text).not.toContain(wrapper);
      expect(text).toContain(
        mode !== '2'
          ? 'Use detail when it improves perception, character'
          : 'Use detail when it improves correctness or verification'
      );
      expect(text).not.toContain(
        mode !== '2'
          ? 'correctness or verification in the requested task.'
          : 'perception, character, causality, atmosphere, or consequence in fiction.'
      );
      expect(JSON.stringify(program)).toBe(before);
    },
    30000
  );
});
