import { expect, test } from 'vitest';
import { compileRisuPrompt, validateRisuPrompt } from '../core/risu-prompt.js';
import { nativePrompt } from './fixtures/native-prompt.js';
const context = {
  slots: {},
  history: [{ id: 'request', role: 'user' as const, text: 'Continue.', current: true }],
};
test('explicit host submission is a boolean independent of native prompt source', () => {
  const program = nativePrompt('', {
    promptTemplate: [{ type: 'chat', rangeStart: 0, rangeEnd: 'end' }],
  });
  expect(compileRisuPrompt(program, context)).not.toHaveProperty('execution');
  for (const storySubmission of [true, false]) {
    const selected = { ...program, execution: { storySubmission } };
    expect(validateRisuPrompt(selected)).toEqual(selected);
    expect(compileRisuPrompt(selected, context).execution).toEqual({ storySubmission });
  }
  for (const execution of [
    null,
    [],
    { tools: ['shell.execute'] },
    { storySubmission: {} },
    { storySubmission: { when: true } },
  ])
    expect(() => validateRisuPrompt({ ...program, execution })).toThrow();
});
