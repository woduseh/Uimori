import { expect, test } from 'vitest';
import {
  buildMainInput,
  CATALOG_CHARS,
  CATALOG_READ_GUIDANCE,
  CATALOG_SUMMARY_CHARS,
  executeTool,
} from '../core/provider.js';
import { buildMainProviderRequest } from '../server/main-request.js';
import { defaultProfile, type Connection } from '../core/product.js';
import type { Resource, RunSnapshot } from '../core/types.js';

const bound: Connection = {
  id: 'fixture-connection',
  revision: 1,
  title: 'Local fixture only',
  protocol: 'fixture-sse-v1',
  endpoint: 'http://127.0.0.1:49999/turn',
  enabled: true,
  catalog: [],
  catalogError: null,
};
const lore = (index: number, overrides: Partial<Resource> = {}): Resource => ({
  id: `lore-${index}`,
  chatId: 'catalog-chat',
  kind: 'lore',
  revision: 1,
  title: `Reference ${index}`,
  description: `Synthetic catalog description ${index}. `.repeat(20),
  text: `Local fictional body ${index}.`,
  sourceKind: 'module',
  loading: 'discoverable',
  ...overrides,
});
function snapshot(resources: Resource[]): RunSnapshot {
  return {
    chatId: 'catalog-chat',
    parentRevision: null,
    settingsRevision: 1,
    request: 'Continue the scene at the harbor.',
    settings: { status: false, maxCalls: 4 },
    history: [],
    resources,
    profile: {
      ...defaultProfile('catalog-chat'),
      models: {
        main: {
          id: 'main-preset',
          revision: 1,
          title: 'Main fixture route',
          connectionId: bound.id,
          modelId: 'fixture-main-selected',
          maxOutputTokens: 4096,
          temperature: null,
          connection: bound,
        },
      },
    },
  };
}

test('the catalog summarises a discoverable entry and lists a pinned one without a summary', () => {
  const discoverable = lore(1, {
    relatedIds: ['lore-2', 'absent-id'],
    loreContext: { placement: 'scene', group: 'harbor', order: 1 },
  });
  const pinned = lore(2, {
    loading: 'pinned',
    loreContext: { placement: 'scene', group: 'harbor', order: 2 },
  });
  const [first, second] = buildMainInput(snapshot([discoverable, pinned])).catalog;
  expect(first.description).toHaveLength(CATALOG_SUMMARY_CHARS);
  expect(first.description.endsWith('…')).toBe(true);
  expect(discoverable.description.startsWith(first.description.slice(0, -1))).toBe(true);
  expect(first.relatedIds).toEqual(['lore-2']);
  expect(first).not.toHaveProperty('loreContext');
  expect(first).not.toHaveProperty('loading');
  expect(second).toMatchObject({
    id: 'lore-2',
    title: 'Reference 2',
    kind: 'lore',
    sourceKind: 'module',
    loading: 'pinned',
    description: '',
  });
  expect(second).not.toHaveProperty('loreContext');
});

test('a catalog past the character budget lists a prefix and points at the read tools', () => {
  const many = Array.from({ length: 400 }, (_, index) => lore(index));
  const input = buildMainInput(snapshot(many));
  const page = input.catalogPage!;
  expect(page.total).toBe(many.length);
  expect(page.listed).toBeGreaterThan(0);
  expect(page.listed).toBeLessThan(many.length);
  expect(page.remaining).toContain('knowledge.search');
  expect(input.catalog.map((item) => item.id)).toEqual(
    many.slice(0, page.listed).map((item) => item.id)
  );
  expect(JSON.stringify(input.catalog).length).toBeLessThanOrEqual(CATALOG_CHARS);
  const small = buildMainInput(snapshot(many.slice(0, 3)));
  expect(small.catalogPage).toBeUndefined();
  expect(small.catalog).toHaveLength(3);
});

test('the request contract asks for a read only while the catalog lists a discoverable entry', () => {
  const contract = (resources: Resource[]) =>
    buildMainProviderRequest(snapshot(resources)).request.stable.contract;
  expect(contract([lore(1)])).toContain(CATALOG_READ_GUIDANCE);
  expect(contract([])).not.toContain(CATALOG_READ_GUIDANCE);
  expect(contract([lore(1, { loading: 'pinned' })])).not.toContain(CATALOG_READ_GUIDANCE);
});

test('knowledge search points directly to an exact late body match without changing metadata-only hits or scope', () => {
  const phrase = 'Lantern password is amber.';
  // Lowercasing this prefix expands its UTF-16 length; offsets must address the original.
  const original = 'İ'.repeat(20_000) + '😀'.repeat(10_000) + phrase + ' End of reference.';
  const resource = lore(1, { text: original });
  const metadataOnly = lore(2, { title: 'Lantern amber index', text: 'No body match.' });
  const fixed = snapshot([
    resource,
    metadataOnly,
    lore(3, { chatId: 'another-chat', text: phrase }),
  ]);
  const found = executeTool(fixed, {
    callId: 'search-late',
    name: 'knowledge.search',
    args: { query: 'lantern amber' },
  });
  expect(found.denied).toBe(false);
  const result = found.result as any;
  expect(result.total).toBe(2);
  expect(result.items.map((item: any) => item.id)).toEqual([resource.id, metadataOnly.id]);
  const hit = result.items[0];
  expect(hit).toMatchObject({ title: resource.title, description: resource.description });
  expect(hit.match.text).toBe(original.slice(hit.match.range.start, hit.match.range.end));
  expect(hit.match.text).toContain(phrase);
  expect(hit.match.text.length).toBeLessThanOrEqual(240);
  expect(hit.match.range.start).toBeGreaterThan(39_000);
  expect(result.items[1]).not.toHaveProperty('match');
  expect(result.items[1]).not.toHaveProperty('nextRead');
  const read = executeTool(fixed, {
    callId: 'read-late',
    name: hit.nextRead.name,
    args: hit.nextRead.arguments,
  });
  expect(read.denied).toBe(false);
  const returned = (read.result as any).items[0].read;
  expect(returned.text).toContain(phrase);
  expect(returned.text).toBe(original.slice(returned.range.start, returned.range.end));
  expect(returned.source.hash).toBe(hit.match.source.hash);
  expect(hit).not.toHaveProperty('text');
  const sequentialReads = Math.ceil((original.indexOf(phrase) + phrase.length) / 4096);
  console.log(
    'KNOWLEDGE_SEARCH_EVIDENCE',
    JSON.stringify({
      scenario: 'synthetic-late-match',
      metadataOnlySearchThenSequentialRead: {
        calls: 1 + sequentialReads,
        bodyChars: Math.min(original.length, sequentialReads * 4096),
      },
      searchThenDirectRead: { calls: 2, bodyChars: hit.match.text.length + returned.text.length },
    })
  );
});

test('knowledge search pages bounded exact excerpts without dropping matches or metadata', () => {
  const resources = Array.from({ length: 35 }, (_, index) =>
    lore(index, {
      description:
        index === 0 ? '\u0001'.repeat(4000) : `Description ${index}: ` + 'm'.repeat(3500),
      text: 'Unreturned prefix. '.repeat(400) + 'Needle at the end. ' + '\n"\\😀'.repeat(80),
    })
  );
  const fixed = snapshot(resources);
  const ids: string[] = [];
  let offset = 0;
  do {
    const event = executeTool(fixed, {
      callId: `page-${offset}`,
      name: 'knowledge.search',
      args: { query: 'needle', offset, limit: 100 },
    });
    expect(event.denied).toBe(false);
    expect(JSON.stringify(event.result).length).toBeLessThanOrEqual(24_000);
    const page = event.result as any;
    expect(page.total).toBe(resources.length);
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      const original = resources.find((resource) => resource.id === item.id)!;
      if (original.id === 'lore-0') {
        expect(item.metadataPreview.description).toMatchObject({ totalChars: 4000 });
        expect(item.metadataPreview.description.returnedChars).toBeLessThan(4000);
        expect(item.description).toBe(
          original.description.slice(0, item.description.length - 1) + '…'
        );
        expect(item.nextRead.arguments.ids).toEqual([original.id]);
      } else expect(item.description).toBe(original.description);
      expect(item.match.text).toBe(
        original.text.slice(item.match.range.start, item.match.range.end)
      );
      expect(item.match.text).toContain('Needle');
      ids.push(item.id);
    }
    if (page.nextOffset === null) break;
    expect(page.nextOffset).toBeGreaterThan(offset);
    offset = page.nextOffset;
  } while (offset < resources.length);
  expect(ids).toEqual(resources.map((resource) => resource.id));
});
