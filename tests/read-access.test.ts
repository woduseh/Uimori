import { expect, test } from 'vitest';
import { CATALOG_READ_GUIDANCE, readAccess, READ_FAMILIES } from '../core/read-access.js';
import type { Resource } from '../core/types.js';

const resource = (id: string, kind: Resource['kind'] = 'lore'): Resource => ({
  id,
  chatId: 'chat',
  kind,
  revision: 1,
  title: id,
  description: '',
  text: `${id} body`,
});
const scope = (overrides: Partial<Parameters<typeof readAccess>[0]> = {}) => ({
  references: [],
  deliveredReferences: new Set<string>(),
  scenes: [],
  deliveredScenes: new Set<string>(),
  ...overrides,
});

test('nothing outside the input offers no read tool, catalog or guidance', () => {
  expect(readAccess(scope(), READ_FAMILIES)).toEqual({
    families: [],
    tools: [],
    catalog: [],
    guidance: [],
  });
});

test('each family is offered only while it has something left to return', () => {
  const lore = resource('lore'),
    skill = resource('skill', 'skill');
  const open = readAccess(
    scope({
      references: [lore, skill],
      scenes: [{ revision: 'old', text: 'Old scene.' }],
      translations: 1,
    }),
    READ_FAMILIES
  );
  expect(open.tools).toEqual([
    'knowledge.search',
    'knowledge.read',
    'skills.list',
    'skills.load',
    'story.search',
    'story.read',
    'translation.search',
    'translation.read',
  ]);
  expect(open.catalog).toEqual([lore, skill]);
  expect(open.guidance).toEqual([CATALOG_READ_GUIDANCE]);

  const delivered = readAccess(
    scope({
      references: [lore, skill],
      deliveredReferences: new Set(['lore', 'skill']),
      scenes: [
        { revision: 'old', text: 'Old scene.' },
        { revision: 'hidden', text: 'Hidden.', sceneContext: { sceneEnabled: false } } as never,
      ],
      deliveredScenes: new Set(['old']),
      translations: 0,
    }),
    READ_FAMILIES
  );
  expect(delivered).toMatchObject({ tools: [], catalog: [], guidance: [] });
});

test('a runtime that does not request a family gets neither its tools nor its catalog entries', () => {
  const lore = resource('lore'),
    skill = resource('skill', 'skill');
  const story = readAccess(
    scope({ references: [lore, skill], scenes: [{ revision: 'old', text: 'Old.' }] }),
    ['story']
  );
  expect(story).toEqual({
    families: ['story'],
    tools: ['story.search', 'story.read'],
    catalog: [],
    guidance: [],
  });
  const skills = readAccess(scope({ references: [lore, skill] }), ['skills']);
  expect(skills.catalog).toEqual([skill]);
  expect(skills.guidance).toEqual([]);
});
