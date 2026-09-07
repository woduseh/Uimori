import { describe, expect, test } from 'vitest';
import { executeStoryRead, STORY_RESULT_MAX_BYTES } from '../core/story-context.js';
import { memoryHash, planMemoryContext, type MemoryEntry, type MemorySourceRef } from '../core/memory.js';
import { defaultStoryConfig } from '../core/story.js';
import type { RunSnapshot } from '../core/types.js';

const sourceText = 'Actual source evidence. '.repeat(600);
const sourceHash = memoryHash(sourceText);
const ref: MemorySourceRef = { revision: 'source-1', hash: sourceHash, start: 0, end: 10000, quote: sourceText.slice(0, 10000) };
const note: MemoryEntry = { id: 'memory-1', chatId: 'chat', atRevision: 'source-1', atHash: sourceHash, kind: 'character-belief', actor: 'Alice', text: 'Alice believes the door is locked. '.repeat(400), sources: [ref] };
function snapshot(entries: MemoryEntry[], text = sourceText): RunSnapshot {
  const history = [{ revision: 'source-1', text }]; const scope = { chatId: 'chat', history };
  const checkpoint = { chatId: 'chat', indexed: [] };
  return { chatId: 'chat', parentRevision: 'source-1', settingsRevision: 1, settings: { preset: 'calm', mode: 'direct', translation: false, status: false, maxCalls: 8 }, request: 'Continue.', resources: [], history,
    story: { config: { ...defaultStoryConfig(), memory: { enabled: true, model: null, recentCount: 2, maxPacketChars: 2000000 } }, state: null, waiting: false, lineageHash: memoryHash(JSON.stringify(history)), canonHash: memoryHash('[]'), models: {}, memory: { entries, checkpoint, plan: planMemoryContext({ scope, entries, checkpoint, maxPacketChars: 2000000 }) } } };
}
function read(fixed: RunSnapshot, name: string, args: Record<string, unknown>) {
  const event = executeStoryRead(fixed, { callId: 'test-call', name, args });
  expect(event.denied, JSON.stringify(event)).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(event.result), 'utf8')).toBeLessThanOrEqual(STORY_RESULT_MAX_BYTES);
  expect(Buffer.byteLength(JSON.stringify(event), 'utf8')).toBeLessThan(STORY_RESULT_MAX_BYTES + 2000);
  return event.result as any;
}

describe('S04/S05 bounded memory and original-source tool responses', () => {
  test('memory.read limit1 never injects the 10000-character evidence quote through provenance', () => {
    const result = read(snapshot([note]), 'memory.read', { id: note.id, limit: 1 });
    expect(result.text).toBe('A'); expect(result.nextOffset).toBe(1);
    expect(result.entry).toMatchObject({ kind: 'character-belief', actor: 'Alice', sources: [{ revision: ref.revision, hash: ref.hash, start: ref.start, end: ref.end }] });
    expect(JSON.stringify(result)).not.toContain('Actual source evidence.');
    expect(JSON.stringify(result)).not.toContain('"quote":');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1200);
    const search = read(snapshot([note]), 'memory.search', { query: 'Alice', limit: 1 });
    expect(search.results[0].excerpt).toHaveLength(240);
    expect(search.results[0].kind).toBe('character-belief');
    expect(JSON.stringify(search)).not.toContain('Actual source evidence.');
  });

  test('authored declaration metadata does not repeat the entire canonical text', () => {
    const text = 'A mandatory authored world fact. '.repeat(500);
    const canon: MemoryEntry = { id: 'canon', chatId: 'chat', kind: 'author-canon', atRevision: null, atHash: null, text, declaration: { author: 'user', text } };
    const result = read(snapshot([canon]), 'memory.read', { id: canon.id, limit: 1 });
    expect(result.text).toBe('A'); expect(result.entry.declaration).toEqual({ author: 'user' });
    expect(result.sourceCount).toBe(0); expect(result.sourceContinuation).toBeNull();
    expect(JSON.stringify(result)).not.toContain('mandatory authored');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(900);
  });

  test('large provenance is explicitly paginated and every exact source coordinate remains recoverable', () => {
    const sources = Array.from({ length: 70 }, (_, index) => ({ revision: ref.revision, hash: ref.hash, start: index, end: index + 5, quote: sourceText.slice(index, index + 5) }));
    const fixed = snapshot([{ ...note, sources }]);
    let sourceOffset: number | null = 0; const recovered: unknown[] = []; let pages = 0;
    while (sourceOffset !== null) {
      const result = read(fixed, 'memory.read', { id: note.id, limit: 1, sourceOffset });
      expect(result.sourceCount).toBe(70); expect(result.text).toBe('A');
      recovered.push(...result.entry.sources); sourceOffset = result.sourceContinuation?.sourceOffset ?? null; pages++;
      expect(pages).toBeLessThan(20);
    }
    expect(pages).toBeGreaterThan(1);
    expect(recovered).toEqual(sources.map(({ quote: _quote, ...coordinates }) => coordinates));
  });

  test('memory.search honors the actual result byte budget and continuation retrieves every matching item', () => {
    const sources = Array.from({ length: 25 }, (_, index) => ({ revision: ref.revision, hash: ref.hash, start: index, end: index + 5, quote: sourceText.slice(index, index + 5) }));
    const entries: MemoryEntry[] = Array.from({ length: 100 }, (_, index) => ({ ...note, id: `memory-${index}`, sources }));
    const fixed = snapshot(entries); let offset: number | null = 0; const recovered: string[] = []; let pages = 0;
    while (offset !== null) {
      const result = read(fixed, 'memory.search', { query: 'Alice', offset, limit: 100 });
      expect(result.total).toBe(100); expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.every((entry: any) => entry.sourceContinuation !== null && entry.provenanceTruncated)).toBe(true);
      recovered.push(...result.results.map((entry: any) => entry.id)); offset = result.nextOffset; pages++;
      expect(pages).toBeLessThan(100);
    }
    expect(pages).toBeGreaterThan(1); expect(recovered).toEqual(entries.map(entry => entry.id));
  });

  test('Unicode and JSON-escaped source/memory bodies use byte-aware text continuation without data loss', () => {
    const text = '한글😀\u0000'.repeat(5000); const hash = memoryHash(text);
    const entry: MemoryEntry = { ...note, text, atHash: hash, sources: [{ revision: 'source-1', hash, start: 0, end: text.length, quote: text }] };
    const fixed = snapshot([entry], text);
    for (const name of ['memory.read', 'story.read']) {
      let offset: number | null = 0; let recovered = ''; let pages = 0;
      while (offset !== null) {
        const result = read(fixed, name, { id: name === 'memory.read' ? entry.id : 'source-1', offset, limit: 16000 });
        expect(result.text.length).toBeGreaterThan(0); expect(result.text.length).toBeLessThan(16000);
        recovered += result.text; offset = result.nextOffset; pages++; expect(pages).toBeLessThan(20);
      }
      expect(pages).toBeGreaterThan(1); expect(recovered).toBe(text);
    }
  });

  test('individual memory reads apply the same current ancestry and chat validation as search counts', () => {
    const fixed = snapshot([{ ...note, chatId: 'private-chat' }]);
    expect(executeStoryRead(fixed, { callId: 'hidden', name: 'memory.read', args: { id: note.id } }).denied).toBe(true);
    expect(read(fixed, 'memory.search', { query: 'Alice' }).total).toBe(0);
    expect(executeStoryRead(snapshot([note]), { callId: 'invalid', name: 'memory.read', args: { id: note.id, sourceOffset: -1 } }).denied).toBe(true);
  });
});
