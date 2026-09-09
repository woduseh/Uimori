import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { sourceHistoryForRequest, sourceLogicalHistoryForRequest } from '../core/source-context.js';
import { executeStoryRead } from '../core/story-context.js';
import type { RunSnapshot } from '../core/types.js';
import { createSourceSegmentFixture } from './fixtures/source-segments.js';

function fixture(excludeAsides = true) {
  const text =
      'Visible introduction.\r\n\r\n@hsTitle: Quiet Bell\r\n⟦Harbor @ Dusk @ Keeper⟧\r\nMira believes the bell is silent.\r\n@hs\r\n\r\nThe reader hears waves.',
    sourceHash = createHash('sha256').update(text).digest('hex');
  const policy = createSourceSegmentFixture({ excludeAsides });
  const history = [{ revision: 'source', text, contentHash: sourceHash, sourceSegments: policy }];
  const snapshot: RunSnapshot = {
    chatId: 'synthetic',
    parentRevision: 'source',
    settingsRevision: 1,
    settings: { preset: 'calm', mode: 'direct', translation: false, status: false, maxCalls: 8 },
    request: 'Next',
    history,
    resources: [],
    sourceSegments: policy,
  };
  return { text, sourceHash, policy, history, snapshot };
}
test('excluded source ranges remain out of history, search and reads while current user input and source identity stay intact', () => {
  const f = fixture(),
    before = structuredClone(f.snapshot),
    history = sourceHistoryForRequest(f.snapshot);
  expect(history[0].text).not.toContain('Mira believes');
  expect(history[0].text).toContain('hears waves');
  expect(history[0].contentHash).toBe(f.sourceHash);
  expect(f.snapshot).toEqual(before);
  const logical = sourceLogicalHistoryForRequest(f.snapshot, [
    {
      id: 'assistant',
      role: 'assistant',
      sourceRevision: 'source',
      sourceHash: f.sourceHash,
      text: f.text,
    },
    { id: 'current', role: 'user', current: true, text: '@hsTitle: literal request' },
  ]);
  expect(logical[0].text).toBe(history[0].text);
  expect(logical[1].text).toBe('@hsTitle: literal request');
  const search = executeStoryRead(
    f.snapshot,
    { callId: 'search', name: 'story.search', args: { query: 'Mira believes' } },
    true
  );
  expect(search.denied).toBe(false);
  expect(search.result).toMatchObject({ total: 0 });
  const read = executeStoryRead(
    f.snapshot,
    { callId: 'read', name: 'story.read', args: { id: 'source', limit: 16000 } },
    true
  );
  expect(read.denied).toBe(false);
  const result = read.result as {
    text: string;
    source: { hash: string };
    keptRanges: { start: number; end: number }[];
  };
  expect(result.text).toBe(history[0].text);
  expect(result.source.hash).toBe(f.sourceHash);
  expect(result.keptRanges.map((r) => f.text.slice(r.start, r.end)).join('')).toBe(result.text);
});
