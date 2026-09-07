import { describe, expect, test } from 'vitest';
import {
  compilePromptProgram,
  validatePromptProgram,
  type PromptExecution,
  type PromptProgram,
} from '../core/prompt-program.js';
import { definePrompt, current } from '../core/prompt-authoring.js';

const program = (execution?: PromptExecution): PromptProgram => ({
  version: 1,
  controls: [{ id: 'submit', label: 'Submit', type: 'boolean', default: true }],
  blocks: [{ id: 'current', title: 'Current', kind: 'current' }],
  ...(execution ? { execution } : {}),
});
const context = {
  slots: {},
  history: [{ id: 'request', role: 'user' as const, text: 'Continue the scene.', current: true }],
};

describe('explicit prompt execution settings', () => {
  test('absence disables submission and an empty declaration enables it without provenance', () => {
    expect(compilePromptProgram(program(), context)).not.toHaveProperty('execution');
    expect(compilePromptProgram(program({ storySubmission: {} }), context).execution).toEqual({
      storySubmission: true,
    });
  });

  test('uses resolved options and frozen runtime through the same bounded expression evaluator', () => {
    const selected = program({
      storySubmission: {
        when: { op: 'all', args: [{ control: 'submit' }, { context: ['ready'] }] },
      },
    });
    const runtime = { ready: true };
    const compiled = compilePromptProgram(selected, { ...context, runtime });
    runtime.ready = false;
    expect(compiled.execution).toEqual({ storySubmission: true });
    expect(compilePromptProgram(selected, { ...context, runtime }).execution).toEqual({
      storySubmission: false,
    });
    expect(
      compilePromptProgram(selected, {
        ...context,
        values: { submit: false },
        runtime: { ready: true },
      }).execution
    ).toEqual({ storySubmission: false });
    expect(
      compilePromptProgram(selected, { ...context, runtime: { ready: null } }).execution
    ).toEqual({ storySubmission: false });
  });

  test('rejects undeclared options and arbitrary tool configuration', () => {
    for (const execution of [
      null,
      [],
      { tools: ['shell.execute'] },
      { storySubmission: true },
      { storySubmission: { tool: 'shell.execute' } },
      { storySubmission: { when: { control: 'missing' } } },
    ]) {
      expect(() => validatePromptProgram({ ...program(), execution })).toThrow();
    }
  });

  test('shares the compilation work budget instead of evaluating execution out of band', () => {
    const selected = program({
      storySubmission: {
        when: { op: 'greater', args: [{ op: 'sum', args: [{ op: 'range', args: [1000] }] }, 0] },
      },
    });
    expect(() => compilePromptProgram(selected, { ...context, limits: { maxSteps: 10 } })).toThrow(
      'PROMPT_STEP_LIMIT'
    );
  });

  test('trusted authoring retains explicit execution configuration in the data artifact', () => {
    const selected = definePrompt({
      controls: {},
      compose: () => [current()],
      execution: { storySubmission: { when: true } },
    });
    expect(selected.execution).toEqual({ storySubmission: { when: true } });
    expect(compilePromptProgram(selected, context).execution).toEqual({ storySubmission: true });
  });
});
