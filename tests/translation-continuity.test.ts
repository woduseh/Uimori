import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { compileTranslationPrompt, executeAuxiliary, translationInput } from '../core/auxiliary.js';
import { defaultProfile } from '../core/product.js';
import { sourceTimeContext, type AuxiliaryBundle } from '../server/product-auxiliary.js';
function bundle(count = 5): AuxiliaryBundle {
  const text = Array.from(
    { length: count },
    () => 'Mira watched the dark harbor while Captain Arlen waited beside the quiet lighthouse.'
  ).join('\n\n');
  const source = {
    id: 'source-continuity',
    chatId: 'chat-continuity',
    text,
    hash: createHash('sha256').update(text).digest('hex'),
  };
  return {
    job: {
      id: 'job-continuity',
      kind: 'translation',
      status: 'queued',
      sourceRevision: source.id,
      sourceHash: source.hash,
    },
    source,
    snapshot: {
      chatId: source.chatId,
      parentRevision: null,
      settingsRevision: 1,
      settings: { preset: 'calm', mode: 'direct', translation: true, status: false, maxCalls: 8 },
      request: 'Synthetic translation continuity',
      history: [],
      resources: [],
      profile: {
        ...defaultProfile(source.chatId),
        revision: 3,
        contents: [
          {
            id: 'mira',
            revision: 2,
            kind: 'bot',
            title: 'Mira',
            description: 'Known relationship',
            text: 'Mira speaks informally with the traveler, an old friend.',
            loading: 'pinned',
            relatedIds: [],
          },
          {
            id: 'traveler',
            revision: 4,
            kind: 'persona',
            title: 'Traveler',
            description: 'Known relationship',
            text: 'The traveler is an old friend of Mira and chooses their own replies.',
            loading: 'pinned',
            relatedIds: [],
          },
          {
            id: 'names',
            revision: 5,
            kind: 'module',
            title: 'Author names',
            description: 'Preferred form',
            text: 'Captain Arlen = 앨런 선장',
            loading: 'pinned',
            relatedIds: [],
          },
        ],
        models: {},
      },
    },
  };
}
describe('whole-source translation continuity', () => {
  test('keeps source-time bot, persona, glossary and prior originals frozen in one input', () => {
    const seed = bundle(20);
    seed.snapshot.history = [{ revision: 'prior', text: 'An earlier source.' }];
    const input = translationInput(
      seed.source,
      sourceTimeContext(seed.snapshot, 'translation'),
      seed.snapshot
    );
    seed.snapshot.profile!.contents[0].text = 'LATER_RELATIONSHIP';
    seed.snapshot.history[0].text = 'LATER_SOURCE';
    expect(input.sourceText).toBe(seed.source.text);
    expect(input.context.bot!.text).toContain('old friend');
    expect(input.context.persona!.text).toContain('old friend');
    expect(input.context.references[0].text).toContain('앨런 선장');
    expect(input.context.previousSources[0].text).toBe('An earlier source.');
    expect(JSON.stringify(input)).not.toMatch(
      /LATER_RELATIONSHIP|LATER_SOURCE|previousTranslation|chunkId/
    );
  });
  test('default prompt receives the full original once and offers prior source, notes and wording reads', async () => {
    const seed = bundle(20);
    const input = translationInput(
      seed.source,
      sourceTimeContext(seed.snapshot, 'translation'),
      seed.snapshot
    );
    const compiled = compileTranslationPrompt(input, seed.snapshot, 'Translate the full source.')!;
    expect(
      compiled.messages
        .flatMap((message) => message.content)
        .filter((part) => part.text.includes(seed.source.text))
    ).toHaveLength(1);
    expect(input.tools).toEqual(
      expect.arrayContaining([
        'story.search',
        'story.read',
        'notes.list',
        'notes.read',
        'translation.search',
        'translation.read',
      ])
    );
    const before = JSON.stringify(input);
    const outcome = await executeAuxiliary(
      input,
      seed.snapshot,
      async () => '앨런 선장은 기다렸다.'
    );
    expect(outcome.modelCalls).toBe(1);
    expect(outcome.output).toBe('앨런 선장은 기다렸다.');
    expect(JSON.stringify(input)).toBe(before);
  });
});
