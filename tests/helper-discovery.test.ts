import { expect, test } from 'vitest';
import {
  describeHelperTools,
  HELPER_APP_TOOLS,
  helperToolTraits,
} from '../server/helper-app-tools.js';

test.each([
  ['rename this chat', 'chat.rename', 'chat'],
  ['change the model for this chat', 'settings.update', 'chat'],
  ['undo the last saved resource edit', 'resource.undo', 'library'],
  ['aboveInputTokens', 'model.pricing.update', 'library'],
  ['기본 외형', 'resource.patch', 'library'],
  ['delete an unused model', 'model.delete', 'library'],
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
    const story = tool.name.startsWith('story.');
    const result = describeHelperTools({ query: tool.name }, story);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]).toMatchObject(tool);
    if (story) expect(describeHelperTools({ query: tool.name }).tools).toEqual([]);
  }
  expect(
    describeHelperTools({ query: ' RESOURCE.READMANY ' }).tools.map((tool) => tool.name)
  ).toEqual(['resource.readMany']);
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
