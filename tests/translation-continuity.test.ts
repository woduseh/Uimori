import { nativeContent } from './fixtures/native-content.js';
import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { translationInput } from '../core/auxiliary.js';
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
      settings: { maxCalls: 8 },
      request: 'Synthetic translation continuity',
      history: [],
      resources: [],
      profile: {
        ...defaultProfile(source.chatId),
        revision: 3,
        packageAttachments: [
          { id: 'mira', revision: 2, role: 'bot' },
          { id: 'traveler', revision: 4, role: 'persona' },
          { id: 'names', revision: 5, role: 'module' },
        ],
        packages: [
          nativeContent(
            {
              name: 'Mira',
              description: 'Mira speaks informally with the traveler, an old friend.',
            },
            { id: 'mira', revision: 2 },
            'bot'
          ),
          nativeContent(
            {
              name: 'Traveler',
              description: 'The traveler is an old friend of Mira and chooses their own replies.',
            },
            { id: 'traveler', revision: 4 },
            'persona'
          ),
          nativeContent(
            { name: 'Author names', description: 'Captain Arlen = 앨런 선장' },
            { id: 'names', revision: 5 },
            'module'
          ),
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
    seed.snapshot.profile!.packages![0].body = 'LATER_RELATIONSHIP';
    seed.snapshot.history[0].text = 'LATER_SOURCE';
    expect(input.sourceText).toBe(seed.source.text);
    const references = input.context.packages!.pinned.map((entry) => entry.text);
    expect(references.filter((text) => text.includes('old friend'))).toHaveLength(2);
    expect(references.some((text) => text.includes('앨런 선장'))).toBe(true);
    expect(input.context.previousSources[0].text).toBe('An earlier source.');
    expect(JSON.stringify(input)).not.toMatch(
      /LATER_RELATIONSHIP|LATER_SOURCE|previousTranslation|chunkId/
    );
  });
});
