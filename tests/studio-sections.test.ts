import { expect, test } from 'vitest';
import type { ContentKind } from '../core/product.js';
import type { RisuContent } from '../core/risu-content.js';
import { nativeContent } from './fixtures/native-content.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { changedValuePaths } from '../web/editor-values.js';
import {
  MODULE_SECTION_ORDER,
  contentChanges,
  contentSection,
  contentSectionRegistry,
  contentSections,
  isAuthoringPath,
  placeSections,
  presetChanges,
  presetSection,
  presetSections,
  type ContentSection,
} from '../web/studio-sections.js';

const placement = (
  content: RisuContent,
  kind: ContentKind,
  current: ContentSection = 'basic',
  pending: string[] = []
) => {
  const placed = placeSections(
    contentSectionRegistry,
    content,
    kind,
    current,
    pending,
    kind === 'module' ? MODULE_SECTION_ORDER : []
  );
  return {
    shown: placed.filter((item) => !item.more).map((item) => item.id),
    more: placed.filter((item) => item.more).map((item) => item.id),
  };
};

test('a section with data, the current section and a pending draft are never under more', () => {
  const persona = nativeContent(
    {
      name: 'Persona',
      character_book: { entries: [{ keys: ['k'], content: 'c', comment: 'Lore' }] },
      post_history_instructions: 'Stay in character.',
    },
    {},
    'persona'
  );
  expect(placement(persona, 'persona').shown).toEqual(['basic', 'lore', 'instructions', 'assets']);
  expect(placement(persona, 'persona', 'translation').shown).toContain('translation');
  expect(placement(persona, 'persona', 'basic', ['package.native.regex']).shown).toContain('regex');
  expect(placement(persona, 'persona').more).toContain('regex');
  expect(placement(persona, 'persona').shown).not.toContain('source');
});

test('owns maps helper paths to the section that edits them', () => {
  expect(contentSection('/package/modules')).toBe('modules');
  expect(contentSection('/package/imageHandoff/enabled')).toBe('display');
  expect(contentSection('/package/nativeRisu/card/extensions/risuai/backgroundHTML')).toBe(
    'display'
  );
  expect(contentSection('/package/nativeRisu/card/extensions/risuai/customScripts/0/in')).toBe(
    'regex'
  );
  expect(contentSection('/package/nativeRisu/module/backgroundEmbedding')).toBe('display');
  expect(contentSection('/package/nativeRisu/module/regex')).toBe('regex');
  expect(contentSection('/package/nativeRisu/module/trigger/0')).toBe('triggers');
  expect(contentSection('/package/nativeRisu/card/extensions/risuai/triggerscript')).toBe(
    'triggers'
  );
  expect(contentSection('/package/nativeRisu/card/character_book/entries/2/content')).toBe('lore');
  expect(contentSection('/package/nativeRisu/card/alternate_greetings/1')).toBe('greetings');
  expect(contentSection('/package/nativeRisu/card/post_history_instructions')).toBe('instructions');
  expect(contentSection('/package/nativeRisu/card/extensions/risuai/defaultVariables')).toBe(
    'variables'
  );
  expect(contentSection('/package/nativeRisu/card/creator_notes')).toBe('basic');
  expect(isAuthoringPath('/package/nativeRisu/card/creator_notes')).toBe(true);
  expect(contentSection('/package/nativeRisu/card/extensions/customField')).toBeNull();
  expect(presetSection('/program/nativeRisuPreset/preset/promptTemplate/3/text')).toBe('blocks');
  expect(presetSection('/program/nativeRisuPreset/preset/regex/0')).toBe('regex');
  expect(presetSection('/program/nativeRisuPreset/preset/customPromptTemplateToggle')).toBe(
    'variables'
  );
  expect(presetSection('/program/nativeRisuPreset/preset/temperature')).toBeNull();
});

test('changed sections follow the rail order, count pending drafts and place unowned paths', () => {
  const before = { title: 'A', package: nativeContent({ name: 'A', first_mes: 'hi' }) };
  const after = structuredClone(before);
  after.title = 'B';
  after.package.nativeRisu.card.name = 'B';
  after.package.nativeRisu.card.first_mes = 'hello';
  after.package.nativeRisu.card.personality = 'quiet';
  const shown = contentSections(after.package, 'bot', 'basic');
  const paths = changedValuePaths(before, after);
  expect(paths).toEqual(
    expect.arrayContaining([
      '/title',
      '/package/nativeRisu/card/name',
      '/package/nativeRisu/card/first_mes',
    ])
  );
  expect(
    contentChanges(shown, paths, ['package.native.regex']).map(({ id, pending }) => [id, pending])
  ).toEqual([
    ['basic', false],
    ['greetings', false],
    ['regex', true],
    ['source', false],
  ]);
  expect(contentChanges(shown, [], ['unknown.draft']).map(({ id }) => id)).toEqual(['basic']);
  expect(changedValuePaths({ list: [1] }, { list: [1, { a: 1 }] })).toEqual(['/list/1']);
  expect(changedValuePaths({ a: undefined }, {})).toEqual([]);

  const program = createDefaultRisuPrompt('Synthetic', 'main');
  const edited = structuredClone(program);
  (edited.nativeRisuPreset.preset.promptTemplate as { text?: string }[])[0]!.text = 'changed';
  const prompts = presetSections(program, true);
  expect(
    presetChanges(
      prompts,
      changedValuePaths({ title: 'P', program }, { title: 'Q', program: edited }),
      ['prompt.native.toggles.invalid']
    ).map(({ id }) => id)
  ).toEqual(['blocks', 'options', 'variables']);
  expect(presetSection('/program/collaboration/enabled')).toBe('collaboration');
});
