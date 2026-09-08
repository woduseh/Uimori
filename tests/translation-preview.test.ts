import { expect, test } from 'vitest';
import { compileTranslationPreview } from '../core/translation-preview.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { DEFAULT_TRANSLATION_PROMPT } from '../core/prompts.js';

test('translation preview includes only the real current translation task and exact source', async () => {
  const source = '  A source.\n\nAnother paragraph. 한글  ';
  const program = createDefaultPromptProgram(DEFAULT_TRANSLATION_PROMPT, 'translation');
  const result = await compileTranslationPreview(program, source, {});
  const current = { id: 'current', title: 'Current', kind: 'current' as const };
  const currentOnly = await compileTranslationPreview(
    { ...program, blocks: [...program.blocks.slice(0, -1), current] },
    source,
    {}
  );
  expect(currentOnly.messages.map((m) => m.content.map((part) => part.text).join(''))).toEqual(
    result.messages.map((m) => m.content.map((part) => part.text).join(''))
  );
  expect(
    result.messages.filter(
      (m) => m.content.map((part) => part.text).join('') === `source:\n${source}`
    )
  ).toHaveLength(1);
  expect(result.messages).toHaveLength(5);
  expect(JSON.stringify(result)).not.toContain('합성 이전');
});

test('translation preview shares source runtime and resolved controls without inventing conversation history', async () => {
  const source = 'Runtime source';
  const result = await compileTranslationPreview(
    {
      version: 1,
      controls: [{ id: 'tone', label: 'Tone', type: 'text', default: 'default' }],
      blocks: [
        {
          id: 'runtime',
          title: 'Runtime',
          kind: 'message',
          role: 'system',
          template: [
            { kind: 'value', expression: { context: ['source', 'text'] } },
            { kind: 'value', expression: { control: 'tone' } },
            { kind: 'value', expression: { context: ['history', 'total'] } },
          ],
        },
        { id: 'current', title: 'Current', kind: 'current' },
      ],
    },
    source,
    { tone: 'chosen' }
  );
  expect(result.messages[0].content.map((part) => part.text).join('')).toBe(
    'Runtime sourcechosen0'
  );
});
