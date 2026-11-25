import { describe, expect, test } from 'vitest';
import {
  createCbsReferenceIndexer,
  indexCbsReferences,
  nativeRisuContentReferenceInput,
  nativeRisuPresetReferenceInput,
} from '../core/cbs-references.js';
import type { RisuContentSource } from '../core/risu-native.js';

const native = (card: Record<string, unknown>, module?: Record<string, unknown>) =>
  ({
    version: 1,
    card,
    ...(module ? { module } : {}),
    assets: [],
    sourceHash: 'hash',
  }) as RisuContentSource;

const bot = (risuai: Record<string, unknown>, card: Record<string, unknown> = {}) =>
  native({ name: 'Bot', ...card, extensions: { risuai } });

const index = (source: RisuContentSource) =>
  indexCbsReferences(nativeRisuContentReferenceInput(source));

const entry = (result: ReturnType<typeof index>, scope: string, name: string) =>
  result.variables.find((item) => item.scope === scope && item.name === name);

describe('content cross references', () => {
  test('collects uses across greetings, lore, regex, background and defaults', () => {
    const result = index(
      bot(
        {
          defaultVariables: 'mood=calm\nunused=1\nempty=',
          customScripts: [
            { comment: 'Mood', type: 'editdisplay', in: 'x', out: '{{setvar::mood::bright}}' },
          ],
          backgroundHTML: '<p>{{getvar::mood}}</p>',
        },
        {
          description: 'Desc {{getvar::mood}}',
          first_mes: 'Hi {{getvar::mood}}',
          alternate_greetings: ['', 'Other {{getvar::missing}}'],
          character_book: { entries: [{ comment: 'Place', content: '{{? $mood + 1}}' }] },
        }
      )
    );
    const mood = entry(result, 'chat', 'mood')!;
    expect(mood).toMatchObject({ reads: 4, writes: 1, defined: true });
    expect(mood.uses.map((use) => [use.section, use.item, use.field, use.access])).toEqual([
      ['basic', null, 'description', 'read'],
      ['greetings', 0, 'first_mes', 'read'],
      ['lore', 0, 'content', 'read'],
      ['display', null, 'backgroundHTML', 'read'],
      ['regex', 0, 'out', 'write'],
      ['variables', null, 'defaultVariables', 'default'],
    ]);
    expect(mood.uses.find((use) => use.section === 'lore')?.label).toBe('Place');
    const greeting = entry(result, 'chat', 'missing')!.uses[0]!;
    expect(greeting).toMatchObject({ section: 'greetings', item: 2, range: { from: 16, to: 23 } });
    expect(result.findings).toEqual([
      { code: 'read-without-default', scope: 'chat', name: 'missing', certain: true },
      { code: 'never-read', scope: 'chat', name: 'unused', certain: true },
    ]);
    expect(entry(result, 'chat', 'empty')).toBeUndefined();
  });

  test('dynamic names turn absence findings into uncertain ones', () => {
    const result = index(
      bot(
        { defaultVariables: 'kept=1' },
        { first_mes: '{{getvar::{{getvar::which}}}} {{getvar::lonely}}' }
      )
    );
    expect(result.dynamic.chat.reads).toBe(1);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        { code: 'never-read', scope: 'chat', name: 'kept', certain: false },
        { code: 'read-without-default', scope: 'chat', name: 'lonely', certain: true },
      ])
    );
  });

  test('reads literal Lua variable calls and marks non-literal ones dynamic', () => {
    const result = index(
      bot({
        triggerscript: [
          {
            comment: 'Setup',
            type: 'start',
            effect: [
              {
                type: 'triggerlua',
                code: [
                  "setChatVar(id, 'hp', 10)",
                  'local v = getChatVar(id, "hp")',
                  "setState(id, 'flags', {})",
                  'getChatVar(id, name)',
                  "local t = getGlobalVar(id, 'toggle_dark')",
                ].join('\n'),
              },
            ],
          },
          {
            type: 'manual',
            conditions: [{ type: 'var', var: 'hp', value: '0', operator: '=' }],
            effect: [{ type: 'setvar', var: 'dead', value: '{{getvar::hp}}', operator: '=' }],
          },
        ],
      })
    );
    const hp = entry(result, 'chat', 'hp')!;
    expect(hp).toMatchObject({ reads: 3, writes: 1 });
    expect(hp.uses.filter((use) => use.origin === 'lua')).toEqual([
      expect.objectContaining({ section: 'triggers', item: 0, label: 'Setup', access: 'write' }),
      expect.objectContaining({ access: 'read', range: { from: 51, to: 53 } }),
    ]);
    expect(entry(result, 'chat', '__flags')?.writes).toBe(1);
    expect(entry(result, 'chat', 'dead')?.uses[0]).toMatchObject({ origin: 'trigger', item: 1 });
    expect(result.dynamic.chat.reads).toBe(1);
    expect(result.findings.find((item) => item.name === 'dead')).toMatchObject({
      code: 'never-read',
      certain: false,
    });
    expect(entry(result, 'global', 'toggle_dark')).toMatchObject({ toggle: 'dark', reads: 1 });
  });

  test('reports unused and undefined toggles', () => {
    const result = index(
      bot(
        { toggles: 'dark=Dark mode\nstyle=Style=select=A,B\n==divider\nGroup=Group=group' },
        { first_mes: '{{#when::toggle::dark}}on{{/when}} {{getglobalvar::toggle_ghost}}' }
      )
    );
    expect(entry(result, 'global', 'toggle_dark')).toMatchObject({ defined: true, reads: 1 });
    expect(result.findings).toEqual([
      { code: 'toggle-undefined', scope: 'global', name: 'toggle_ghost', certain: true },
      { code: 'toggle-unused', scope: 'global', name: 'toggle_style', certain: true },
    ]);
  });

  test('uses module fields for a standalone module', () => {
    const result = index(
      native(
        {},
        {
          name: 'Module',
          description: '{{getvar::a}}',
          lorebook: [{ comment: 'L', content: '{{setvar::a::1}}' }],
          defaultVariables: 'a=0',
          customModuleToggle: 'm=Mode',
        }
      )
    );
    expect(entry(result, 'chat', 'a')?.uses.map((use) => use.section)).toEqual([
      'basic',
      'lore',
      'variables',
    ]);
    expect(entry(result, 'global', 'toggle_m')?.uses[0]?.field).toBe('customModuleToggle');
  });

  test('reuses analysis for unchanged text', () => {
    const indexer = createCbsReferenceIndexer();
    const entries = Array.from({ length: 400 }, (_, i) => ({
      comment: `Entry ${i}`,
      content: `{{getvar::v${i % 20}}} ${'text '.repeat(200)}`,
    }));
    const source = bot({}, { character_book: { entries } });
    indexer(nativeRisuContentReferenceInput(source));
    const started = performance.now();
    const result = indexer(nativeRisuContentReferenceInput(source));
    expect(performance.now() - started).toBeLessThan(100);
    expect(entry(result, 'chat', 'v0')?.reads).toBe(20);
  });
});

test('preset cross references cover blocks, regex and toggles', () => {
  const result = indexCbsReferences(
    nativeRisuPresetReferenceInput({
      promptTemplate: [
        { type: 'plain', name: 'Main', text: '{{#when::toggle::nsfw}}x{{/when}}' },
        { type: 'persona', innerFormat: '{{getvar::tone}}' },
      ],
      regex: [{ comment: 'R', in: 'a', out: '{{getglobalvar::toggle_style}}' }],
      customPromptTemplateToggle: 'nsfw=NSFW\nstyle=Style=select=A,B\nspare=Spare',
      templateDefaultVariables: 'tone=dry',
    })
  );
  expect(
    result.variables.find((item) => item.toggle === 'nsfw')?.uses.map((use) => use.section)
  ).toEqual(['blocks', 'variables']);
  expect(result.variables.find((item) => item.name === 'tone')?.uses[0]).toMatchObject({
    section: 'blocks',
    item: 1,
    field: 'innerFormat',
  });
  expect(result.findings).toEqual([
    { code: 'toggle-unused', scope: 'global', name: 'toggle_spare', certain: true },
  ]);
});
