import { describe, expect, test } from 'vitest';
import { executeStoryRead, STORY_RESULT_MAX_BYTES } from '../core/story-context.js';
import { sourceHash } from '../core/source-history.js';
import { validateAuthorNote, type AuthorNote } from '../core/notes.js';
import { defaultStoryConfig } from '../core/story.js';
import type { RunSnapshot } from '../core/types.js';

const sourceText = 'Exact source evidence. '.repeat(1000);
const note = (id = 'note', text = 'The harbor is blue.'): AuthorNote => ({
  id,
  chatId: 'chat',
  atRevision: null,
  atHash: null,
  kind: 'author-note',
  text,
  declaration: { author: 'user', text },
});
const snapshot = (notes: AuthorNote[] = [], text = sourceText): RunSnapshot => ({
  chatId: 'chat',
  parentRevision: 'source',
  settingsRevision: 1,
  settings: { preset: 'calm', mode: 'direct', translation: false, status: false, maxCalls: 8 },
  request: 'Continue.',
  resources: [],
  history: [{ revision: 'source', text, contentHash: sourceHash(text) }],
  story: {
    config: defaultStoryConfig(),
    state: null,
    waiting: false,
    lineageHash: 'synthetic',
    canonHash: sourceHash('[]'),
    models: {},
    notes,
  },
});
function read(fixed: RunSnapshot, name: string, args: Record<string, unknown>) {
  const event = executeStoryRead(fixed, { callId: 'read', name, args });
  expect(event.denied, JSON.stringify(event)).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(event.result))).toBeLessThanOrEqual(
    STORY_RESULT_MAX_BYTES
  );
  return event.result as any;
}
describe('bounded source reads and explicit notes', () => {
  test('notes.read returns one requested range without repeating the full declaration in metadata', () => {
    const entry = note('long', 'An explicit correction. '.repeat(1200));
    const result = read(snapshot([entry]), 'notes.read', { id: entry.id, limit: 1 });
    expect(result.text).toBe('A');
    expect(result.nextOffset).toBe(1);
    expect(result).toMatchObject({
      id: entry.id,
      kind: 'author-note',
      author: 'user',
      atRevision: null,
      atHash: null,
    });
    expect(JSON.stringify(result)).not.toContain('explicit correction');
    expect(JSON.stringify(result)).not.toContain('Exact source evidence');
  });
  test('notes.list honors byte pagination and every matching note remains discoverable', () => {
    const entries = Array.from({ length: 100 }, (_, i) =>
      note('note-' + i, '🌙'.repeat(500) + ' marker')
    );
    const fixed = snapshot(entries);
    let offset: number | null = 0;
    const ids: string[] = [];
    while (offset !== null) {
      const page = read(fixed, 'notes.list', { query: 'marker', offset, limit: 100 });
      ids.push(...page.results.map((entry: AuthorNote) => entry.id));
      offset = page.nextOffset;
    }
    expect(ids).toEqual(entries.map((entry) => entry.id));
    expect(read(fixed, 'notes.list', {}).total).toBe(100);
  });
  test('Unicode and escaped content roundtrips through bounded source and note ranges', () => {
    const text = '🌙 "quoted" \n'.repeat(1500),
      entry = note('unicode', text),
      fixed = snapshot([entry], text);
    for (const [name, id] of [
      ['notes.read', entry.id],
      ['story.read', 'source'],
    ]) {
      let offset: number | null = 0,
        recovered = '';
      while (offset !== null) {
        const page = read(fixed, name, { id, offset, limit: 16000 });
        recovered += page.text;
        offset = page.nextOffset;
      }
      expect(recovered).toBe(text);
    }
  });
  test('source tools are available without extraction settings and cannot read another branch', () => {
    const fixed = snapshot();
    delete fixed.story;
    expect(read(fixed, 'story.search', { query: 'Exact source' }).total).toBe(1);
    expect(read(fixed, 'story.read', { id: 'source', limit: 5 }).text).toBe('Exact');
    expect(
      executeStoryRead(fixed, {
        callId: 'foreign',
        name: 'story.read',
        args: { id: 'other-branch' },
      }).denied
    ).toBe(true);
    expect(
      executeStoryRead(fixed, { callId: 'old', name: 'memory.read', args: { id: 'source' } }).denied
    ).toBe(true);
  });
  test('notes are filtered by exact source ancestry, chat and hash', () => {
    const anchored = { ...note('anchored'), atRevision: 'source', atHash: sourceHash(sourceText) };
    const fixed = snapshot([
      anchored,
      { ...note('foreign'), chatId: 'other' },
      { ...note('future'), atRevision: 'future', atHash: sourceHash('future') },
    ]);
    expect(read(fixed, 'notes.list', {}).results.map((entry: AuthorNote) => entry.id)).toEqual([
      'anchored',
    ]);
    fixed.history[0] = { revision: 'source', text: 'edited', contentHash: sourceHash('edited') };
    expect(read(fixed, 'notes.list', {}).total).toBe(0);
    expect(
      executeStoryRead(fixed, { callId: 'retired', name: 'notes.read', args: { id: 'anchored' } })
        .denied
    ).toBe(true);
  });
  test('an extraction result cannot become an explicit note', () => {
    const scope = { chatId: 'chat', history: [] };
    expect(() =>
      validateAuthorNote({ ...note(), kind: 'observed-story', sources: [] }, scope)
    ).toThrow('STORY_NOTE_INVALID');
    expect(() =>
      validateAuthorNote({ ...note(), declaration: { author: 'user', text: 'different' } }, scope)
    ).toThrow('STORY_NOTE_INVALID');
  });
});

describe('ancestry listing and lenient search for model-driven retrieval', () => {
  const chapters = [
    'Mira promised the Captain a lantern before the storm.',
    'The captain left the harbor at dawn.\nNobody saw the lantern again.',
    'A quiet evening. Mira wrote a letter.',
  ];
  const listed = (): RunSnapshot => {
    const fixed = snapshot();
    fixed.history = chapters.map((text, index) => ({
      revision: `chapter-${index}`,
      text,
      contentHash: sourceHash(text),
    }));
    fixed.parentRevision = 'chapter-2';
    return fixed;
  };
  test('story.list walks the exact ancestry in order with previews and window membership', () => {
    const fixed = listed();
    fixed.contextPlan = {
      version: 1,
      status: 'ready',
      budget: { inputTokenLimit: 8192, estimator: 'o200k_base-v1' },
      dependencyKey: 'synthetic',
      estimatedInputTokens: 10,
      compacted: [{ revision: 'chapter-0', hash: sourceHash(chapters[0]) }],
      recentSourceRevisions: ['chapter-1', 'chapter-2'],
      summary: 'derived',
      summaryCalls: 0,
      usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      error: null,
    };
    const page = read(fixed, 'story.list', {});
    expect(page.total).toBe(3);
    expect(page.results.map((item: { revision: string }) => item.revision)).toEqual([
      'chapter-0',
      'chapter-1',
      'chapter-2',
    ]);
    expect(page.results[0]).toMatchObject({
      index: 0,
      hash: sourceHash(chapters[0]),
      chars: chapters[0].length,
      compacted: true,
    });
    expect(page.results[1]).toMatchObject({ index: 1, compacted: false });
    expect(page.results[1].preview).toBe(
      'The captain left the harbor at dawn. Nobody saw the lantern again.'
    );
    const second = read(fixed, 'story.list', { offset: 1, limit: 1 });
    expect(second.results.map((item: { revision: string }) => item.revision)).toEqual([
      'chapter-1',
    ]);
    expect(second.nextOffset).toBe(2);
    expect(
      executeStoryRead(fixed, { callId: 'q', name: 'story.list', args: { query: 'x' } }).denied
    ).toBe(true);
    delete fixed.contextPlan;
    expect(
      read(fixed, 'story.list', {}).results.every((item: { compacted: boolean }) => !item.compacted)
    ).toBe(true);
  });
  test('story.search matches every whitespace-separated term case-insensitively inside one exchange', () => {
    const fixed = listed();
    const both = read(fixed, 'story.search', { query: 'CAPTAIN' });
    expect(both.total).toBe(2);
    expect(both.results.map((item: { revision: string }) => item.revision)).toEqual([
      'chapter-0',
      'chapter-1',
    ]);
    expect(both.results[0].source.start).toBe(0);
    expect(both.results[0].text).toContain('Captain');
    const narrowed = read(fixed, 'story.search', { query: 'lantern captain' });
    expect(narrowed.total).toBe(2);
    expect(read(fixed, 'story.search', { query: 'lantern storm' }).total).toBe(1);
    expect(read(fixed, 'story.search', { query: 'lantern letter' }).total).toBe(0);
    expect(
      executeStoryRead(fixed, { callId: 'blank', name: 'story.search', args: { query: '   ' } })
        .denied
    ).toBe(true);
  });
});
