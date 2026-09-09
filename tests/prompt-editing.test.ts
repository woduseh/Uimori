import { expect, test } from 'vitest';
import {
  validatePromptProgram,
  validateEditablePromptProgram,
  resolvePromptValues,
  resolveEditablePromptValues,
  reconcilePromptValues,
  evaluatePromptExpression,
  type PromptProgram,
} from '../core/prompt-program.js';

const program = (): PromptProgram => ({
  version: 1,
  controls: [
    { id: 'switch', label: 'Switch', type: 'boolean', default: false },
    { id: 'text', label: 'Text', type: 'text', default: null },
    { id: 'number', label: 'Number', type: 'number', default: null },
    {
      id: 'select',
      label: 'Select',
      type: 'select',
      default: null,
      options: [{ label: 'A', value: 'a' }],
    },
  ],
  blocks: [],
});

test('new boolean definitions and saved values require true or false without changing other null controls', () => {
  const value = program();
  expect(validateEditablePromptProgram(value)).toEqual(value);
  expect(resolveEditablePromptValues(value)).toEqual({
    switch: false,
    text: null,
    number: null,
    select: null,
  });
  expect(resolveEditablePromptValues(value, { switch: true })).toMatchObject({ switch: true });
  expect(() => resolveEditablePromptValues(value, { switch: null })).toThrow(
    'PROMPT_INVALID_CONTROL_VALUE'
  );
  value.controls[0].default = null;
  expect(() => validateEditablePromptProgram(value)).toThrow('PROMPT_INVALID_CONTROL_VALUE');
  expect(() => resolveEditablePromptValues(value, { switch: false })).toThrow(
    'PROMPT_INVALID_CONTROL_VALUE'
  );
});

test('legacy boolean null retains its exact runtime and reconciliation value while failed edits do not mutate it', () => {
  const original = program();
  original.controls[0].default = null;
  const snapshot = structuredClone(original);
  const values = { switch: null };
  expect(validatePromptProgram(original)).toEqual(snapshot);
  expect(resolvePromptValues(original, values)).toMatchObject(values);
  expect(reconcilePromptValues(original, values)).toMatchObject({ values, resetKeys: [] });
  expect(
    evaluatePromptExpression({ op: 'equal', args: [{ control: 'switch' }, null] }, values)
  ).toBe(true);
  expect(() => validateEditablePromptProgram(original)).toThrow();
  expect(() => resolveEditablePromptValues(original, values)).toThrow();
  expect(original).toEqual(snapshot);
  expect(values).toEqual({ switch: null });
});
