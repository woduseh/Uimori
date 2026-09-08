import { describe, expect, test } from 'vitest';
import { translationInput } from '../core/auxiliary.js';
import { compileTranslationPrompt } from '../core/translation-prompt.js';
import {
  compilePromptProgram,
  renderPromptTemplate,
  type PromptProgram,
} from '../core/prompt-program.js';
import { sourceTimeContext } from '../server/product-auxiliary.js';
import { bundle } from './fixtures/translation-job.js';

// Synthetic reproduction of the failing authored slot layout; no private source/prompt text.
const program = (): PromptProgram => ({
  version: 1,
  controls: [],
  blocks: [
    {
      id: 'pheme-7',
      title: 'Translation references',
      kind: 'message',
      role: 'user',
      template: [
        { kind: 'text', text: '<source>' },
        { kind: 'slot', name: 'source' },
        { kind: 'text', text: '</source><glossary>' },
        { kind: 'slot', name: 'glossary' },
        { kind: 'text', text: '</glossary><lore>' },
        { kind: 'slot', name: 'lore' },
        { kind: 'text', text: '</lore>' },
      ],
    },
    { id: 'current', title: 'Current translation', kind: 'current' },
  ],
});

describe('translation authored slot contracts', () => {
  test.each([true, false])(
    'glossary is explicitly empty while frozen references remain available (references=%s)',
    (references) => {
      const seed = bundle();
      if (!references) seed.snapshot.profile!.contents = [];
      seed.snapshot.profile!.promptPresets = {
        translation: {
          id: 'current-translation',
          revision: 9,
          role: 'translation',
          title: 'Frozen translation',
          program: program(),
        },
      };
      const input = translationInput(
        seed.source,
        sourceTimeContext(seed.snapshot, 'translation'),
        seed.snapshot
      );
      const before = structuredClone({ input, snapshot: seed.snapshot });
      const compilation = compileTranslationPrompt(input, seed.snapshot, 'Translate source.')!;
      const text = compilation.messages[0].content[0].text;
      expect(text).toContain('<glossary></glossary>');
      expect(text).toContain(`<source>${seed.source.text}</source>`);
      if (references) {
        expect(text).toContain('<lore>Mira = 미라\n\nThe identity remains unknown.</lore>');
        expect(input.context.references.map((reference) => reference.text)).toEqual([
          'Mira = 미라',
          'The identity remains unknown.',
        ]);
      } else expect(text).toContain('<lore></lore>');
      expect({ input, snapshot: seed.snapshot }).toEqual(before);
    }
  );

  test.each(['template', 'block', 'nested', 'slot-template'] as const)(
    'unknown %s slots retain block ID separately from slot name',
    (kind) => {
      const bad = program();
      bad.blocks =
        kind === 'block'
          ? [{ id: 'pheme-7', title: 'Unknown slot', kind: 'slot', slot: 'missing', role: 'user' }]
          : kind === 'slot-template'
            ? [
                {
                  id: 'pheme-7',
                  title: 'Unknown slot',
                  kind: 'slot',
                  slot: 'source',
                  role: 'user',
                  template: [{ kind: 'slot', name: 'missing' }],
                },
              ]
            : [
                {
                  id: 'pheme-7',
                  title: 'Unknown slot',
                  kind: 'message',
                  role: 'user',
                  template:
                    kind === 'nested'
                      ? [{ kind: 'if', condition: true, then: [{ kind: 'slot', name: 'missing' }] }]
                      : [{ kind: 'slot', name: 'missing' }],
                },
              ];
      const before = structuredClone(bad);
      expect(() =>
        compilePromptProgram(bad, { slots: { source: 'Original' }, history: [] })
      ).toThrow(
        expect.objectContaining({
          code: 'PROMPT_UNKNOWN_SLOT',
          blockId: 'pheme-7',
          slotName: 'missing',
        })
      );
      expect(bad).toEqual(before);
    }
  );

  test('standalone template errors name the missing slot without inventing a block ID', () => {
    expect(() => renderPromptTemplate([{ kind: 'slot', name: 'missing' }])).toThrow(
      expect.objectContaining({
        code: 'PROMPT_UNKNOWN_SLOT',
        blockId: undefined,
        slotName: 'missing',
      })
    );
  });
});
