import { describe, expect, test } from 'vitest';
import Fastify from 'fastify';
import { STORY_READ_TOOLS } from '../core/story-read-tools.js';
import { executeStoryRead, STORY_RESULT_MAX_BYTES } from '../core/story-context.js';
import { countTextTokens } from '../core/text-tokens.js';
import { readStorySource, sourceHash } from '../core/source-history.js';
import { modelAuthorNotes, validateAuthorNote, type AuthorNote } from '../core/notes.js';
import type { RunSnapshot } from '../core/types.js';

const sourceText = 'Exact source evidence.';
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

test('model-facing schemas accept browse, search and numbered reads and reject invalid selectors', async () => {
  const app = Fastify({ ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
  try {
    for (const tool of STORY_READ_TOOLS)
      app.post(`/${tool.name}`, { schema: { body: tool.inputSchema } }, (_req, reply) =>
        reply.code(204).send()
      );
    const status = async (tool: string, payload: object) =>
      (await app.inject({ method: 'POST', url: `/${tool}`, payload })).statusCode;
    for (const query of [undefined, '', 'harbor'])
      expect(await status('story.search', { query, offset: 1, limit: 1 })).toBe(204);
    expect(await status('story.read', { sceneNumber: 2 })).toBe(204);
    for (const args of [
      {},
      { id: 'middle' },
      { sceneNumber: 0 },
      { sceneNumber: 1.5 },
      { sceneNumber: '2' },
      { sceneNumber: 2, id: 'middle' },
      { sceneNumber: 2, limit: 16001 },
    ])
      expect(await status('story.read', args)).toBe(400);
  } finally {
    await app.close();
  }
});

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
    const listed = read(fixed, 'story.search', {});
    expect(listed.results.map((item: { revision: string }) => item.revision)).toEqual([
      'chapter-0',
      'chapter-1',
      'chapter-2',
    ]);
    expect(listed.results[0]).toMatchObject({
      sceneNumber: 1,
      hash: sourceHash(texts[0]),
    });
    const page = read(fixed, 'story.search', { query: '', offset: 1, limit: 1 });
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

test.each(['한국어 원문과 범위를 확인해요. ', '🙂🌸🎉'])(
  'token reads preserve original ranges and legacy UTF-16 limits: %s',
  (phrase) => {
    const text = phrase.repeat(120);
    const fixed = snapshot(text);
    let offset = 0;
    let joined = '';
    let pages = 0;
    while (offset < text.length) {
      const result = read(fixed, 'story.read', { sceneNumber: 1, offset, maxTokens: 256 });
      expect(countTextTokens(result.text)).toBeLessThanOrEqual(256);
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.text).toBe(text.slice(offset, result.source.end));
      expect(result.source.hash).toBe(sourceHash(text));
      expect(result.text.isWellFormed()).toBe(true);
      joined += result.text;
      offset = result.source.end;
      pages++;
    }
    expect(pages).toBeGreaterThan(1);
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
  }
);
