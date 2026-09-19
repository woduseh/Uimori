import { describe, expect, it } from 'vitest';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { createAgentCollaboration } from '../core/agent-collaboration.js';
import { parsePromptFile } from '../core/prompt-file.js';

describe('native prompt files', () => {
  const program = createDefaultRisuPrompt('Translate the complete source.', 'translation');
  program.nativeRisuPreset.preset.customPromptTemplateToggle = 'tone=Tone=text';
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
      ...createDefaultRisuPrompt('Write.', 'main'),
      collaboration: createAgentCollaboration(),
    };
    const file = { title: '작문', role: 'main' as const, program: main, values: {} };
    expect(parsePromptFile(JSON.parse(JSON.stringify(file)))).toEqual(file);
  });
  it('accepts a standalone program without inventing a title or role', () => {
    expect(parsePromptFile(program)).toEqual({ program, values: { tone: null } });
  });
  it('rejects the removed suggested-combination wrapper', () => {
    expect(() =>
      parsePromptFile({ program, suggestedCombination: { values: { tone: 'warm' } } })
    ).toThrow('RISU_NATIVE_PROMPT_FILE_REQUIRED');
  });
  it('rejects bad metadata and unknown or invalid options before applying anything', () => {
    expect(() => parsePromptFile({ program, role: 'image' })).toThrow();
    expect(() => parsePromptFile({ program, title: 12 })).toThrow();
    expect(() => parsePromptFile({ program, values: { unknown: true } })).toThrow();
    expect(() => parsePromptFile({ program, values: { tone: false } })).toThrow();
  });
});
