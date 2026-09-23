import { describe, expect, test } from 'vitest';
import { executeStoryRead, STORY_RESULT_MAX_BYTES } from '../core/story-context.js';
import { sourceHash } from '../core/source-history.js';
import { validateAuthorNote, type AuthorNote } from '../core/notes.js';
import type { RunSnapshot } from '../core/types.js';

const sourceText = 'Exact source evidence. '.repeat(1000);
const snapshot = (text = sourceText): RunSnapshot => ({
  chatId: 'chat',
  parentRevision: 'source',
  settingsRevision: 1,
  settings: { status: false, maxCalls: 8 },
  request: 'Continue.',
  resources: [],
  history: [{ revision: 'source', text, contentHash: sourceHash(text) }],
});
function read(fixed: RunSnapshot, name: string, args: Record<string, unknown>) {
  const event = executeStoryRead(fixed, { callId: 'read', name, args });
  expect(event.denied, JSON.stringify(event)).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(event.result))).toBeLessThanOrEqual(
    STORY_RESULT_MAX_BYTES
  );
  return event.result as any;
}

describe('bounded story ancestry reads', () => {
  test('Unicode and escaped content round-trip through scene-number pagination', () => {
    const text = '🌙 "quoted" \n'.repeat(1500);
    const fixed = snapshot(text);
    let offset: number | null = 0;
    let recovered = '';
    while (offset !== null) {
      const page = read(fixed, 'story.read', { sceneNumber: 1, offset, limit: 16000 });
      expect(page.source.start).toBe(offset);
      recovered += page.text;
      offset = page.nextOffset;
    }
    expect(recovered).toBe(text);
  });

  test('story.search provides both ordered browsing and case-insensitive multi-term search', () => {
    const texts = [
      'Mira promised the Captain a lantern before the storm.',
      'The captain left the harbor at dawn.\nNobody saw the lantern again.',
      'A quiet evening. Mira wrote a letter.',
    ];
    const fixed = snapshot();
    fixed.history = texts.map((text, index) => ({
      revision: `chapter-${index}`,
      text,
      contentHash: sourceHash(text),
    }));
    fixed.parentRevision = 'chapter-2';
    fixed.contextPlan = {
      version: 1,
      status: 'ready',
      budget: { inputTokenLimit: 8192, estimator: 'o200k_base-v1' },
      dependencyKey: 'synthetic',
      estimatedInputTokens: 10,
      compacted: [{ revision: 'chapter-0', hash: sourceHash(texts[0]) }],
      recentSourceRevisions: ['chapter-1', 'chapter-2'],
      summary: 'derived',
      summaryCalls: 0,
      usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      error: null,
    };

    const listed = read(fixed, 'story.search', {});
    expect(listed.results.map((item: { revision: string }) => item.revision)).toEqual([
      'chapter-0',
      'chapter-1',
      'chapter-2',
    ]);
    expect(listed.results[0]).toMatchObject({
      sceneNumber: 1,
      hash: sourceHash(texts[0]),
      compacted: true,
    });
    const page = read(fixed, 'story.search', { offset: 1, limit: 1 });
    expect(page.results).toMatchObject([{ sceneNumber: 2, revision: 'chapter-1' }]);
    expect(page.nextOffset).toBe(2);

    const both = read(fixed, 'story.search', { query: 'CAPTAIN lantern' });
    expect(both.results.map((item: { sceneNumber: number }) => item.sceneNumber)).toEqual([1, 2]);
    expect(read(fixed, 'story.search', { query: 'lantern storm' }).total).toBe(1);
    expect(read(fixed, 'story.search', { query: 'lantern letter' }).total).toBe(0);
  });

  test('reads cannot cross ancestry or ignore a stale source hash', () => {
    const fixed = snapshot();
    expect(
      executeStoryRead(fixed, { callId: 'outside', name: 'story.read', args: { sceneNumber: 2 } })
    ).toMatchObject({ denied: true, result: { code: 'RESOURCE_UNAVAILABLE' } });
    fixed.history[0].contentHash = sourceHash('different');
    expect(
      executeStoryRead(fixed, { callId: 'stale', name: 'story.read', args: { sceneNumber: 1 } })
    ).toMatchObject({ denied: true, result: { code: 'RESOURCE_UNAVAILABLE' } });
  });
});

describe('author-note validation stays separate from model read tools', () => {
  const note = (text = 'The harbor is blue.'): AuthorNote => ({
    id: 'note',
    chatId: 'chat',
    atRevision: null,
    atHash: null,
    kind: 'author-note',
    text,
    declaration: { author: 'user', text },
  });
  test('derived observations still cannot masquerade as explicit user notes', () => {
    const scope = { chatId: 'chat', history: [] };
    expect(() =>
      validateAuthorNote({ ...note(), kind: 'observed-story', sources: [] }, scope)
    ).toThrow('STORY_NOTE_INVALID');
    expect(() =>
      validateAuthorNote({ ...note(), declaration: { author: 'user', text: 'different' } }, scope)
    ).toThrow('STORY_NOTE_INVALID');
  });
});

test('browse previews normalize real whitespace and preserve literal backslashes', () => {
  const fixed = snapshot('First\t  line\nSecond \\section');
  expect(read(fixed, 'story.search', {}).results[0].preview).toBe('First line Second \\section');
});

test('mistyped scene and range are correctable while corrupt source history stays terminal', () => {
  const fixed = snapshot('original');
  const invoke = (args: Record<string, unknown>) =>
    executeStoryRead(fixed, { callId: 'read', name: 'story.read', args });
  expect(invoke({ sceneNumber: 2 })).toMatchObject({
    denied: true,
    errorKind: 'recoverable',
    result: { code: 'RESOURCE_UNAVAILABLE' },
  });
  expect(invoke({ sceneNumber: 1, offset: 100 })).toMatchObject({
    denied: true,
    errorKind: 'recoverable',
    result: { code: 'INVALID_ARGUMENTS' },
  });
  for (const offset of ['0', null, false]) {
    expect(invoke({ sceneNumber: 1, offset })).toMatchObject({
      denied: true,
      errorKind: 'recoverable',
      result: { code: 'INVALID_ARGUMENTS' },
    });
  }
  expect(invoke({ sceneNumber: 1 })).toMatchObject({ denied: false, result: { text: 'original' } });
  fixed.history[0].contentHash = sourceHash('corrupt');
  const corrupt = invoke({ sceneNumber: 1 });
  expect(corrupt).toMatchObject({ denied: true, result: { code: 'RESOURCE_UNAVAILABLE' } });
  expect(corrupt).not.toHaveProperty('errorKind');
});
