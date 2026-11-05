import { expect, test } from 'vitest';
import {
  describeHelperTools,
  HELPER_APP_TOOLS,
  helperToolTraits,
} from '../server/helper-app-tools.js';

// Keyword-retrieval oracles, not autonomous model choices or execution-quality scores.
test.each([
  ['rename this chat', 'chat.rename', 'chat'],
  ['change the title of this chat', 'chat.rename', 'chat'],
  ['find saved chats by title', 'chat.list', 'library'],
  ['list my saved chats', 'chat.list', 'library'],
  ['change the model for this chat', 'settings.update', 'chat'],
  ['set the shared character appearance defaults', 'resource.patch', 'library'],
  ['save chat-only appearance profiles', 'illustration.profiles.save', 'chat'],
  ['read the original scene text', 'scene.read', 'chat'],
  ['search for a phrase in previous scenes', 'scene.search', 'chat'],
  ['undo the last saved resource edit', 'resource.undo', 'library'],
  ['duplicate this bot', 'resource.clone', 'library'],
  ['copy a prompt preset', 'resource.clone', 'library'],
  ['move these bots into a folder', 'library.organize', 'library'],
  ['how much did I spend last month', 'usage.read', 'library'],
  ['retry a failed helper task', 'task.retry', 'library'],
  ['inspect failed helper task status', 'task.inspect', 'library'],
  ['set global font', 'font.select', 'library'],
  ['find available themes', 'theme.list', 'library'],
  ['library profile', 'resource.patch', 'library'],
  ['resource oldText', 'resource.patch', 'library'],
  ['aboveInputTokens', 'model.pricing.update', 'library'],
] as const)(
  'discovery returns %s candidates with the needed %s schema',
  (query, expected, scope) => {
    const result = describeHelperTools({ query }, false, scope);
    expect(result.tools.length).toBeLessThanOrEqual(3);
    expect(result.tools.map((tool) => tool.name)).toContain(expected);
    for (const tool of result.tools)
      expect(tool).toMatchObject(describeHelperTools({ names: [tool.name] }).tools[0]!);
  }
);

test('every exact operation name returns one complete schema with its original execution spelling', () => {
  for (const tool of HELPER_APP_TOOLS) {
    const result = describeHelperTools({ query: tool.name });
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]).toMatchObject(tool);
  }
  expect(
    describeHelperTools({ query: ' RESOURCE.READMANY ' }).tools.map((tool) => tool.name)
  ).toEqual(['resource.readMany']);
});

test('query pages contain complete schemas and exact names select only that operation', () => {
  expect(describeHelperTools({ query: 'read' }).tools).toHaveLength(3);
  expect(
    describeHelperTools({ query: 'oldText' }).tools.some((tool) =>
      ['resource.patch', 'scene.patch'].includes(tool.name)
    )
  ).toBe(true);
  const exact = describeHelperTools({ query: 'resource.patch', limit: 10 }, false, 'chat');
  expect(exact.tools.map((tool) => tool.name)).toEqual(['resource.patch']);
  const first = describeHelperTools({ query: 'read', limit: 2 });
  if (!('nextOffset' in first)) throw new Error('Expected query page');
  expect(first.tools).toHaveLength(2);
  expect(first.nextOffset).toBe(2);
  const second = describeHelperTools({ query: 'read', limit: 2, offset: first.nextOffset });
  expect(second.tools).toHaveLength(2);
  expect(second.tools.map((tool) => tool.name)).not.toEqual(first.tools.map((tool) => tool.name));
  for (const tool of [...first.tools, ...second.tools])
    expect(tool).toMatchObject(describeHelperTools({ names: [tool.name] }).tools[0]!);
  expect(describeHelperTools({ query: 'zznotatoolzz' }).tools).toEqual([]);
  expect(describeHelperTools({ query: 'the and my' }).tools).toEqual([]);
  for (const limit of [0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1])
    expect(() => describeHelperTools({ query: 'read', limit })).toThrow('INVALID_ARGUMENTS');
});

test('review discovery applies its allowed operation set before ranking and paging', () => {
  const result = describeHelperTools({ query: 'read', limit: 1000 }, true);
  expect(result.tools.length).toBeGreaterThan(0);
  for (const tool of result.tools) {
    expect(helperToolTraits(tool.name).reviewAllowed).toBe(true);
    expect(tool).toMatchObject(describeHelperTools({ names: [tool.name] }, true).tools[0]!);
  }
  expect(describeHelperTools({ query: 'resource.patch' }, true).tools).toEqual([]);
});
