import { describe, expect, it } from 'vitest';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { createAgentCollaboration } from '../core/agent-collaboration.js';
import { parsePromptFile } from '../core/prompt-file.js';

describe('native prompt files', () => {
  const program = {
    ...createDefaultPromptProgram('Translate the complete source.', 'translation'),
    controls: [{ id: 'tone', label: 'Tone', type: 'text' as const, default: 'neutral' }],
  };
  it('round trips title, role, program and default option values', () => {
    const file = {
      title: '번역 프롬프트',
      role: 'translation' as const,
      program,
      values: { tone: 'warm' },
    };
    expect(parsePromptFile(JSON.parse(JSON.stringify(parsePromptFile(file))))).toEqual(file);
  });
  it('preserves collaboration configuration inside the program', () => {
    const main = {
      ...createDefaultPromptProgram('Write.', 'main'),
      collaboration: createAgentCollaboration(),
    };
    const file = { title: '작문', role: 'main' as const, program: main, values: {} };
    expect(parsePromptFile(JSON.parse(JSON.stringify(file)))).toEqual(file);
  });
  it('accepts a standalone program without inventing a title or role', () => {
    expect(parsePromptFile(program)).toEqual({ program, values: { tone: 'neutral' } });
  });
  it('imports suggested options as the default selection', () => {
    expect(
      parsePromptFile({ program, suggestedCombination: { values: { tone: 'warm' } } }).values
    ).toEqual({ tone: 'warm' });
  });
  it('rejects bad metadata and unknown or invalid options before applying anything', () => {
    expect(() => parsePromptFile({ program, role: 'image' })).toThrow();
    expect(() => parsePromptFile({ program, title: 12 })).toThrow();
    expect(() => parsePromptFile({ program, values: { unknown: true } })).toThrow();
    expect(() => parsePromptFile({ program, values: { tone: false } })).toThrow();
  });
});
