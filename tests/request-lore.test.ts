import { expect, test } from 'vitest';
import { DEFAULT_LORE_CONTEXT, type RetainedLore } from '../core/lore-context.js';
import { executeTool, knowledgeReadResults } from '../core/provider.js';
import { serializeRisuLoreSources } from '../core/risu-context-source.js';
import type { Json, ProviderRequest, WireRecord } from '../core/transport.js';
import type { Resource, RunSnapshot } from '../core/types.js';
import { requestLore } from '../server/request-lore.js';

const resource = (id: string, text: string, risuSource?: Resource['risuSource']): Resource => ({
  id,
  chatId: 'lore-evidence',
  revision: 1,
  kind: 'lore',
  title: id,
  description: '',
  text,
  loading: 'discoverable',
  ...(risuSource ? { risuSource } : {}),
});
const snapshot = (resources: Resource[]): RunSnapshot => ({
  chatId: 'lore-evidence',
  parentRevision: null,
  settingsRevision: 1,
  settings: { status: false, maxCalls: 4 },
  request: 'Continue the scene.',
  history: [],
  resources,
});
const request = (input: Partial<ProviderRequest['input']> = {}): ProviderRequest => ({
  role: 'main',
  modelId: 'synthetic-model',
  stable: { contract: '', tools: [] },
  input: { task: 'Continue the scene.', controls: {}, ...input },
});
const wire = (...texts: string[]): WireRecord => ({
  connectionId: 'synthetic',
  protocol: 'anthropic-messages-v1',
  role: 'main',
  modelId: 'synthetic-model',
  method: 'POST',
  url: 'http://127.0.0.1:1/messages',
  headers: {},
  body: { messages: [{ role: 'user', content: texts.map((text) => ({ type: 'text', text })) }] },
  bodySha256: 'a'.repeat(64),
  stablePrefixSha256: 'b'.repeat(64),
});

test('pinned evidence distinguishes source and entry markers despite identical short bodies', () => {
  const source = { sourceRole: 'bot', sourceName: 'Card', contentId: 'card-a', entryId: 'a' };
  for (const otherSource of [
    { ...source, contentId: 'card-b' },
    { ...source, entryId: 'b' },
  ]) {
    const a = resource('A', 'yes', source),
      b = resource('B', 'yes', otherSource),
      c = resource('C', 'Catalog body is not supplied.'),
      adjacent = resource('adjacent', 'Another entry.', { ...source, entryId: 'adjacent' });
    const fixed = snapshot([a, b, c, adjacent]);
    const input = request({ catalog: [{ id: c.id, title: c.title }] });
    const sent = wire(
      serializeRisuLoreSources([a, adjacent]),
      JSON.stringify({ catalog: input.input.catalog })
    );
    const before = structuredClone({ fixed, input, sent });
    expect(requestLore(fixed, input, sent, { pinned: [a, b] })).toEqual({
      status: 'partial',
      entries: [
        {
          id: 'A',
          title: 'A',
          source: { contentId: 'card-a', entryId: 'a', sourceName: 'Card' },
          via: 'pinned',
          delivery: 'full',
        },
        {
          id: 'B',
          title: 'B',
          source: {
            contentId: otherSource.contentId,
            entryId: otherSource.entryId,
            sourceName: 'Card',
          },
          via: 'pinned',
          delivery: 'unverified',
        },
      ],
    });
    expect({ fixed, input, sent }).toEqual(before);
  }
  const legacy = { id: 'legacy', kind: 'lore', text: 'An older pinned source.' };
  expect(
    requestLore(snapshot([]), request(), wire(JSON.stringify(legacy)), {
      pinned: [legacy],
      catalog: [{ id: 'legacy', kind: 'lore', title: 'Preserved catalog title' }],
    }).entries
  ).toEqual([{ id: 'legacy', title: 'Preserved catalog title', via: 'pinned', delivery: 'full' }]);
});

test('retained lore requires the exact delivered reference and remains a retained excerpt', () => {
  const item = resource('retained', '0123456789');
  for (const [start, end] of [
    [2, 8],
    [0, 10],
  ] as const) {
    const retained: RetainedLore = {
      id: item.id,
      title: item.title,
      revision: item.revision,
      hash: 'c'.repeat(64),
      start,
      end,
      text: item.text.slice(start, end),
      origin: {
        sourceRevision: 'scene-1',
        sourceHash: 'd'.repeat(64),
        runId: 'run-1',
        callId: 'read-1',
      },
      lastUsed: 'scene-2',
    };
    const fixed = snapshot([item]);
    fixed.loreContext = {
      version: 1,
      policy: DEFAULT_LORE_CONTEXT,
      canonHash: 'e'.repeat(64),
      dependencies: [],
      entries: [retained],
      stats: {
        retainedChars: end - start,
        retainedTokens: 1,
        retainedEntries: 1,
        appendedChars: 0,
        droppedEntries: 0,
        reasons: [],
      },
    };
    const input = request();
    expect(
      requestLore(fixed, input, wire('No retained reference in this prompt.'), { pinned: [] })
    ).toEqual({
      status: 'partial',
      entries: [{ id: item.id, title: item.title, via: 'retained', delivery: 'unverified' }],
    });
    const { lastUsed: _lastUsed, ...sent } = retained;
    expect(requestLore(fixed, input, wire(JSON.stringify([sent])), { pinned: [] })).toEqual({
      status: 'complete',
      entries: [{ id: item.id, title: item.title, via: 'retained', delivery: 'excerpt' }],
    });
  }
});

test('read and search bodies prove delivery while catalog-only hits and compacted references do not prove full text', () => {
  const full = resource('full', 'The keeper lights the lantern.'),
    excerpt = resource('excerpt', 'Before '.repeat(60) + 'NEEDLE promise. ' + 'After '.repeat(60)),
    catalogOnly = resource('NEEDLE catalog-only', 'The search term appears only in this title.');
  const fixed = snapshot([full, excerpt, catalogOnly]);
  const read = executeTool(fixed, {
    callId: 'read-1',
    name: 'knowledge.read',
    args: { ids: [full.id, 'unavailable'] },
  });
  const search = executeTool(fixed, {
    callId: 'search-1',
    name: 'knowledge.search',
    args: { query: 'NEEDLE' },
  });
  const input = request({ results: [read, search] as unknown as Json });
  const sent = wire();
  sent.protocol = 'vertex-gemini-v1';
  sent.body = {
    contents: [
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'knowledge_read', response: read.result } },
          { functionResponse: { name: 'knowledge_search', response: search.result } },
        ],
      },
    ],
  } as Json;
  expect(requestLore(fixed, input, sent, { pinned: [] })).toEqual({
    status: 'complete',
    entries: [
      { id: full.id, title: full.title, via: 'tool-result', delivery: 'full' },
      { id: excerpt.id, title: excerpt.title, via: 'tool-result', delivery: 'excerpt' },
    ],
  });
  const compacted = {
    kind: 'host-compacted-reads',
    summary: 'The keeper has a task involving a lantern.',
    references: [
      {
        name: 'knowledge.read',
        args: read.args,
        returned: {
          items: knowledgeReadResults(read).map(({ source, range, totalChars, nextOffset }) => ({
            source,
            range,
            totalChars,
            nextOffset,
          })),
        },
      },
    ],
  };
  const fresh = request({
    source: {
      completedToolHistory: { events: [{ ...read, result: compacted }] },
    } as unknown as Json,
  });
  expect(requestLore(fixed, fresh, wire(JSON.stringify(compacted)), { pinned: [] })).toEqual({
    status: 'complete',
    entries: [{ id: full.id, title: full.title, via: 'tool-result', delivery: 'summary' }],
  });
});
