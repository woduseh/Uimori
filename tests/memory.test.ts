import { describe, expect, test } from 'vitest';
import {
  markMemoryIndexed,
  memoryHash,
  planMemoryContext,
  readMemorySource,
  resolveMemoryCheckpoint,
  searchMemoryEntries,
  searchMemorySources,
  validateMemoryCheckpoint,
  validateMemoryEntry,
  visibleMemoryEntries,
  type MemoryCheckpoint,
  type MemoryEntry,
  type MemoryScope,
} from '../core/memory.js';

const scope: MemoryScope = {
  chatId: 'story',
  history: [
    { revision: 'r1', text: 'Alice believes the door is locked.' },
    { revision: 'r2', text: 'The door opens.' },
  ],
};
const belief: MemoryEntry = {
  id: 'belief',
  chatId: 'story',
  atRevision: 'r1',
  atHash: memoryHash(scope.history[0].text),
  kind: 'character-belief',
  actor: 'Alice',
  text: 'Alice believes the door is locked.',
  sources: [
    {
      revision: 'r1',
      hash: memoryHash(scope.history[0].text),
      start: 0,
      end: scope.history[0].text.length,
      quote: scope.history[0].text,
    },
  ],
};
const canon: MemoryEntry = {
  id: 'author-declaration',
  chatId: 'story',
  atRevision: null,
  atHash: null,
  kind: 'author-canon',
  text: 'The moon is blue.',
  declaration: { author: 'user', text: 'The moon is blue.' },
};

describe('S04 typed memory provenance and ancestry', () => {
  test('author-canon accepts a declaration with no transcript or fake message ID', () => {
    expect(validateMemoryEntry(canon, { chatId: 'story', history: [] })).toEqual(canon);
    expect(() =>
      validateMemoryEntry({ ...canon, sources: [{ revision: 'fake-message' }] }, scope)
    ).toThrow('UNKNOWN_FIELD');
    expect(() =>
      validateMemoryEntry(
        { ...canon, declaration: { author: 'user', text: 'Changed claim' } },
        scope
      )
    ).toThrow('INVALID_DECLARATION');
  });
  test('beliefs retain actor and category; source-free observations, fake quotes, and future evidence fail', () => {
    expect(validateMemoryEntry(belief, scope)).toEqual(belief);
    expect(() => validateMemoryEntry({ ...belief, actor: undefined }, scope)).toThrow(
      'ACTOR_REQUIRED'
    );
    expect(() => validateMemoryEntry({ ...belief, sources: [] }, scope)).toThrow('SOURCE_REQUIRED');
    expect(() =>
      validateMemoryEntry(
        { ...belief, sources: [{ ...belief.sources[0], quote: 'invented' }] },
        scope
      )
    ).toThrow('INVALID_SOURCE_RANGE');
    expect(() =>
      validateMemoryEntry(
        {
          ...belief,
          sources: [
            { revision: 'r2', hash: memoryHash('The door opens.'), start: 0, end: 3, quote: 'The' },
          ],
        },
        scope
      )
    ).toThrow('OUT_OF_SCOPE');
    for (const kind of ['observed-story', 'derived-summary', 'preference'] as const) {
      const { actor: _actor, ...base } = belief;
      expect(validateMemoryEntry({ ...base, kind }, scope).kind).toBe(kind);
    }
    expect(
      planMemoryContext({ scope, entries: [belief, canon] }).memories.map((entry) => entry.kind)
    ).toEqual(['character-belief', 'author-canon']);
  });
  test('other chat, sibling, future and retconned memory is excluded from reads, search and counts', () => {
    const candidates: MemoryEntry[] = [
      belief,
      canon,
      { ...belief, id: 'other', chatId: 'elsewhere' },
      { ...belief, id: 'sibling', atRevision: 'sibling' },
      { ...belief, id: 'future', atRevision: 'r3' },
    ];
    expect(visibleMemoryEntries(scope, candidates).map((entry) => entry.id)).toEqual([
      'belief',
      'author-declaration',
    ]);
    expect(searchMemoryEntries(scope, candidates, '').total).toBe(2);
    const retcon = { ...scope, history: [{ revision: 'r1', text: 'Different beginning.' }] };
    expect(visibleMemoryEntries(retcon, candidates)).toEqual([canon]);
    expect(planMemoryContext({ scope: retcon, entries: candidates }).visibleMemoryCount).toBe(1);
    expect(() => readMemorySource(scope, { revision: 'sibling' })).toThrow('OUT_OF_SCOPE');
    expect(
      searchMemorySources({ ...scope, history: scope.history.slice(0, 1) }, { query: 'opens' })
        .total
    ).toBe(0);
  });
  test('strict inputs reject extra fields, bad hashes, duplicates and nonserializable payloads', () => {
    expect(() => validateMemoryEntry({ ...belief, callback: () => null }, scope)).toThrow(
      'UNKNOWN_FIELD'
    );
    expect(() =>
      validateMemoryEntry(belief, {
        ...scope,
        history: [{ ...scope.history[0], contentHash: 'fake' }],
      })
    ).toThrow('SOURCE_HASH_MISMATCH');
    expect(() =>
      validateMemoryCheckpoint({ chatId: 'story', indexed: [{ revision: 'r1', hash: 'bad' }] })
    ).toThrow('INVALID_CHECKPOINT');
    expect(() =>
      planMemoryContext({
        scope: { ...scope, history: [scope.history[0], scope.history[0]] },
        entries: [],
      })
    ).toThrow('INVALID_HISTORY');
  });
});

describe('S05 contiguous checkpoint and long source recovery', () => {
  test('out-of-order completion cannot jump holes and a hash edit rewinds the watermark', () => {
    const later = markMemoryIndexed(scope, null, 'r2');
    expect(resolveMemoryCheckpoint(scope, later).watermark).toBeNull();
    expect(planMemoryContext({ scope, entries: [], checkpoint: later }).recentHistory).toHaveLength(
      2
    );
    const complete = markMemoryIndexed(scope, later, 'r1');
    expect(resolveMemoryCheckpoint(scope, complete).watermark).toBe('r2');
    const edited = {
      ...scope,
      history: [{ ...scope.history[0], text: 'retconned' }, scope.history[1]],
    };
    expect(resolveMemoryCheckpoint(edited, complete)).toMatchObject({
      watermark: null,
      indexedCount: 0,
    });
    expect(resolveMemoryCheckpoint(scope, { ...complete, chatId: 'other' }).watermark).toBeNull();
    expect(
      resolveMemoryCheckpoint(
        { ...scope, history: [scope.history[0], { revision: 'sibling', text: 'Sibling.' }] },
        complete
      ).watermark
    ).toBe('r1');
    expect(later.indexed).toHaveLength(1);
  });
  test('long indexed history compacts input, preserves unprocessed tail and original sources, and paginates actual old text', () => {
    const long: MemoryScope = {
      chatId: 'long',
      history: Array.from({ length: 100 }, (_, index) => ({
        revision: `r${index}`,
        text: `chapter-${index}: ${'장면과 대화 '.repeat(1000)} ending-${index}`,
      })),
    };
    const before = JSON.stringify(long);
    let checkpoint: MemoryCheckpoint | null = null;
    for (const item of long.history.slice(0, 98))
      checkpoint = markMemoryIndexed(long, checkpoint, item.revision);
    const plan = planMemoryContext({
      scope: long,
      entries: [],
      checkpoint,
      recentCount: 2,
      maxPacketChars: 20000,
    });
    expect(plan).toMatchObject({
      watermark: 'r97',
      indexedCount: 98,
      unprocessedCount: 2,
      ready: true,
    });
    expect(plan.recentHistory.map((item) => item.revision)).toEqual(['r98', 'r99']);
    expect(plan.packetChars).toBeLessThan(before.length / 20);
    let offset: number | null = 0;
    let recovered = '';
    while (offset !== null) {
      const page = readMemorySource(long, { revision: 'r0', offset, limit: 997 });
      expect(page.source.quote).toBe(page.text);
      expect(page.source.hash).toBe(memoryHash(long.history[0].text));
      recovered += page.text;
      offset = page.nextOffset;
    }
    expect(recovered).toBe(long.history[0].text);
    const search = searchMemorySources(long, { query: 'ending-', limit: 7, excerptChars: 80 });
    expect(search).toMatchObject({ total: 100, nextOffset: 7 });
    expect(search.results[0].text).toContain('ending-0');
    expect(
      searchMemorySources(long, { query: 'ending-', offset: 7, limit: 7 }).results[0].revision
    ).toBe('r7');
    expect(JSON.stringify(long)).toBe(before);
  });
  test('oversized unprocessed tail is explicit and never silently truncated', () => {
    const long = { chatId: 'story', history: [{ revision: 'unindexed', text: 'x'.repeat(10000) }] };
    const plan = planMemoryContext({ scope: long, entries: [canon], maxPacketChars: 1000 });
    expect(plan.ready).toBe(false);
    expect(plan.diagnostics).toContain('UNPROCESSED_TAIL_EXCEEDS_CONTEXT_BUDGET');
    expect(plan.recentHistory[0].text).toHaveLength(10000);
    expect(plan.memories).toEqual([canon]);
    expect(plan.omittedMemories).toBe(0);
  });

  test('author canon is mandatory even when it alone exceeds the packet budget; only derived memories may be omitted', () => {
    const text = 'Mandatory authored world constraint. '.repeat(100);
    const large: MemoryEntry = { ...canon, text, declaration: { author: 'user', text } };
    const plan = planMemoryContext({ scope, entries: [large, belief], maxPacketChars: 1000 });
    expect(plan.ready).toBe(false);
    expect(plan.memories).toEqual([large]);
    expect(plan.diagnostics).toContain('MANDATORY_CONTEXT_EXCEEDS_CONTEXT_BUDGET');
    expect(plan.diagnostics).not.toContain('UNPROCESSED_TAIL_EXCEEDS_CONTEXT_BUDGET');
    expect(plan.omittedMemories).toBe(1);
    expect(plan.recentHistory.map((item) => item.text)).toEqual(
      scope.history.map((item) => item.text)
    );
    const onlyAuthored = planMemoryContext({
      scope: { chatId: 'story', history: [] },
      entries: [large],
      maxPacketChars: 1000,
    });
    expect(onlyAuthored).toMatchObject({ ready: false, memories: [large], omittedMemories: 0 });
  });
});
