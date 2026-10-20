import { describe, expect, test } from 'vitest';
import { executeStoryRead, STORY_RESULT_MAX_BYTES } from '../core/story-context.js';
import { countTextTokens } from '../core/text-tokens.js';
import { readStorySource, searchStorySources, sourceHash } from '../core/source-history.js';
import { modelAuthorNotes, validateAuthorNote, type AuthorNote } from '../core/notes.js';
import type { RunSnapshot } from '../core/types.js';

const sourceText = 'Exact source evidence. '.repeat(1000);
const snapshot = (text = sourceText): RunSnapshot => ({
  chatId: 'chat',
  parentRevision: 'source',
  settingsRevision: 1,
  settings: { maxCalls: 8 },
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
  test('model notes contain each body once while preserving authorship, origins and source anchors', () => {
    const original: AuthorNote[] = [
      { ...note('USER_CORRECTION_BODY'), atRevision: 'source', atHash: sourceHash(sourceText) },
      {
        ...note('IMPORTED_MEMORY_BODY'),
        id: 'imported',
        kind: 'imported-memory',
        origin: { fileHash: 'a'.repeat(64), entryId: 'entry', title: 'Imported memory' },
      },
    ];
    const before = structuredClone(original);
    const projected = modelAuthorNotes(original);
    expect(projected).toEqual([
      { ...original[0], declaration: { author: 'user' } },
      { ...original[1], declaration: { author: 'user' } },
    ]);
    for (const body of ['USER_CORRECTION_BODY', 'IMPORTED_MEMORY_BODY'])
      expect(JSON.stringify(projected).split(body)).toHaveLength(2);
    projected[0].declaration.author = 'changed projection';
    projected[1].origin!.title = 'changed projection';
    expect(original).toEqual(before);
    expect(validateAuthorNote(original[1], { chatId: 'chat', history: [] })).toEqual(original[1]);
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
  fixed.history[0].contentHash = undefined;
  fixed.history[0].text = 'revised';
  expect(invoke({ sceneNumber: 1 })).toMatchObject({
    denied: false,
    result: { text: 'revised', source: { hash: sourceHash('revised') } },
  });
});

test.each([
  'Plain English prose. ',
  '한국어 원문과 범위를 확인해요. ',
  '日本語の原文を読みます。',
  '🙂🌸🎉',
])('token reads preserve original ranges and legacy UTF-16 limits: %s', (phrase) => {
  const text = phrase.repeat(2000);
  const fixed = snapshot(text);
  let offset = 0;
  let joined = '';
  while (offset < text.length) {
    const result = read(fixed, 'story.read', { sceneNumber: 1, offset, maxTokens: 256 });
    expect(countTextTokens(result.text)).toBeLessThanOrEqual(256);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text).toBe(text.slice(offset, result.source.end));
    expect(result.source.hash).toBe(sourceHash(text));
    expect(result.text.isWellFormed()).toBe(true);
    joined += result.text;
    offset = result.source.end;
  }
  expect(joined).toBe(text);
  expect(read(fixed, 'story.read', { sceneNumber: 1, offset: 2, limit: 17 }).text).toBe(
    text.slice(2, 19)
  );
  const source = readStorySource(
    { chatId: fixed.chatId, history: fixed.history },
    { revision: 'source', maxTokens: 128 }
  );
  expect(source.source.quote).toBe(source.text);
  expect(source.text).toBe(text.slice(source.source.start, source.source.end));
  expect(countTextTokens(source.text)).toBeLessThanOrEqual(128);
});

test('search token excerpts retain literal source offsets and explicit character compatibility', () => {
  const text = '한국어 문장. '.repeat(100) + 'needle' + ' 後ろの文章🌸'.repeat(100);
  const scope = { chatId: 'chat', history: [{ revision: 'r', text }] };
  const tokenResult = searchStorySources(scope, { query: 'needle', excerptTokens: 80 }).results[0];
  expect(tokenResult.text).toContain('needle');
  expect(countTextTokens(tokenResult.text)).toBeLessThanOrEqual(80);
  expect(tokenResult.text).toBe(text.slice(tokenResult.source.start, tokenResult.source.end));
  const legacy = searchStorySources(scope, { query: 'needle', excerptChars: 40 }).results[0];
  expect(legacy.source.start).toBe(text.indexOf('needle') - 10);
  expect(legacy.text).toHaveLength(40);
});

test('too-small token pages are recoverable rather than returning a stationary continuation', () => {
  const event = executeStoryRead(snapshot('🌸'.repeat(10)), {
    callId: 'small',
    name: 'story.read',
    args: { sceneNumber: 1, maxTokens: 1 },
  });
  expect(event).toMatchObject({
    denied: true,
    errorKind: 'recoverable',
    result: { code: 'INVALID_ARGUMENTS' },
  });
});
