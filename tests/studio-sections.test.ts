import { expect, test } from 'vitest';
import type { ContentKind } from '../core/product.js';
import type { RisuContent } from '../core/risu-content.js';
import { nativeContent } from './fixtures/native-content.js';
import {
  MODULE_SECTION_ORDER,
  contentSection,
  contentSectionRegistry,
  defaultContentSection,
  isAuthoringPath,
  placeSections,
  presetSection,
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
const standaloneModule = (module: Record<string, unknown>) => {
  const pkg = nativeContent({}, {}, 'module');
  pkg.nativeRisu.card = {};
  pkg.nativeRisu.module = { name: 'Module', ...module };
  return pkg;
};

test('a bot shows every available section in group order', () => {
  expect(placement(nativeContent({ name: 'Bot' }), 'bot')).toEqual({
    shown: [
      'basic',
      'greetings',
      'lore',
      'instructions',
      'assets',
      'appearances',
      'translation',
      'display',
      'variables',
      'triggers',
      'regex',
      'modules',
      'source',
    ],
    more: [],
  });
});

test('an empty persona shows its defaults and keeps the rest under more', () => {
  const { shown, more } = placement(nativeContent({ name: 'Persona' }, {}, 'persona'), 'persona');
  expect(shown).toEqual(['basic', 'assets']);
  expect(more).toContain('lore');
  expect(more).toContain('source');
});

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

test('a standalone module leads with lore and orders groups by the module defaults', () => {
  const { shown, more } = placement(standaloneModule({}), 'module');
  expect(shown).toEqual(['lore', 'basic', 'triggers', 'regex', 'variables', 'assets']);
  expect(more).toEqual(['modules', 'appearances', 'translation', 'source']);
  expect([...MODULE_SECTION_ORDER].sort()).toEqual(
    contentSectionRegistry
      .filter((section) => section.defaultFor.includes('module'))
      .map((section) => section.id)
      .sort()
  );
});

test('display needs a card or image instructions and greetings need a card', () => {
  const standalone = placement(standaloneModule({}), 'module');
  expect([...standalone.shown, ...standalone.more]).not.toContain('display');
  expect([...standalone.shown, ...standalone.more]).not.toContain('greetings');
  const carded = placement(nativeContent({ name: 'Carded' }, {}, 'module'), 'module');
  expect(carded.shown.slice(0, 3)).toEqual(['lore', 'basic', 'triggers']);
  expect(carded.shown).toContain('display');
  expect(carded.more).toContain('greetings');
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

test('each kind opens on its first default section', () => {
  expect(defaultContentSection(nativeContent({ name: 'Bot' }), 'bot')).toBe('basic');
  expect(defaultContentSection(nativeContent({}, {}, 'persona'), 'persona')).toBe('basic');
  expect(defaultContentSection(standaloneModule({}), 'module')).toBe('lore');
  expect(defaultContentSection(nativeContent({ name: 'Carded' }, {}, 'module'), 'module')).toBe(
    'lore'
  );
});
