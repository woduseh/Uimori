import { countTextTokens } from '../core/text-tokens.js';
import { expect, test } from 'vitest';
import {
  buildMainInput,
  resourceCatalog,
  CATALOG_TOKENS,
  CATALOG_READ_GUIDANCE,
  CATALOG_SUMMARY_TOKENS,
  executeTool,
  KNOWLEDGE_READ_TOKENS,
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
    settings: { maxCalls: 4 },
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
  expect(countTextTokens(first.description)).toBeLessThanOrEqual(CATALOG_SUMMARY_TOKENS);
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

test('a catalog past the token budget lists a prefix and points at the read tools', () => {
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
  expect(countTextTokens(JSON.stringify(input.catalog))).toBeLessThanOrEqual(CATALOG_TOKENS);
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
  expect(countTextTokens(hit.match.text)).toBeLessThanOrEqual(120);
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
    expect(countTextTokens(JSON.stringify(event.result))).toBeLessThanOrEqual(6000);
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

test('knowledge read pages preserve item errors, text offsets, and every unread id', () => {
  const resources = Array.from({ length: 15 }, (_, index) =>
    lore(index, {
      text: index === 0 ? '\u0001'.repeat(5000) : `EXACT_${index}: ` + '한글 원문 '.repeat(1500),
    })
  );
  const fixed = snapshot(resources);
  const ids = ['missing', ...resources.map(({ id }) => id)];
  const seen: string[] = [];
  let remaining = ids;
  while (remaining.length) {
    const event = executeTool(fixed, {
      callId: 'page',
      name: 'knowledge.read',
      args: { ids: remaining },
    });
    expect(event.denied).toBe(false);
    expect(countTextTokens(JSON.stringify(event.result))).toBeLessThanOrEqual(
      KNOWLEDGE_READ_TOKENS
    );
    const page = event.result as any;
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      seen.push(item.id);
      if (item.id === 'missing') {
        expect(item).toMatchObject({ denied: true, error: { code: 'RESOURCE_UNAVAILABLE' } });
        continue;
      }
      const original = resources.find((resource) => resource.id === item.id)!.text;
      let text = item.read.text;
      let nextOffset = item.read.nextOffset;
      expect(text).toBe(original.slice(0, item.read.range.end));
      while (nextOffset !== null) {
        const next = executeTool(fixed, {
          callId: 'text',
          name: 'knowledge.read',
          args: { ids: [item.id], offset: nextOffset },
        });
        expect(countTextTokens(JSON.stringify(next.result))).toBeLessThanOrEqual(
          KNOWLEDGE_READ_TOKENS
        );
        const read = (next.result as any).items[0].read;
        expect(read.range.start).toBe(nextOffset);
        expect(read.range.end).toBeGreaterThan(nextOffset);
        text += read.text;
        nextOffset = read.nextOffset;
      }
      expect(text).toBe(original);
    }
    remaining = page.nextIndex === null ? [] : remaining.slice(page.nextIndex);
  }
  expect(seen).toEqual(ids);
  const common = executeTool(fixed, {
    callId: 'common',
    name: 'knowledge.read',
    args: { ids: [resources[1].id] },
  });
  const read = (common.result as any).items[0].read;
  expect(read.text).toBe(resources[1].text.slice(0, read.range.end));
  expect(countTextTokens(JSON.stringify(common.result))).toBeLessThanOrEqual(KNOWLEDGE_READ_TOKENS);
});

test('catalog construction does not tokenize descriptions after the page is full', () => {
  let descriptionsRead = 0;
  const resources = Array.from({ length: 400 }, (_, index) => {
    const resource = lore(index);
    const description = resource.description;
    Object.defineProperty(resource, 'description', {
      get: () => {
        descriptionsRead++;
        return description;
      },
    });
    return resource;
  });
  const result = resourceCatalog(resources);
  expect(result.catalogPage!.total).toBe(400);
  expect(result.catalog.length).toBeGreaterThan(0);
  expect(result.catalog.map(({ id }) => id)).toEqual(
    resources.slice(0, result.catalog.length).map(({ id }) => id)
  );
  expect(countTextTokens(JSON.stringify(result.catalog))).toBeLessThanOrEqual(CATALOG_TOKENS);
  // One candidate can be inspected to discover that the current page is full.
  expect(descriptionsRead).toBeLessThanOrEqual(result.catalog.length + 1);
});

test.each([
  ['English title', 'Asterion', 'Asterion', 'The keeper guards an ancient seal.'],
  ['Korean particles', '미나를 찾아요', '인물 기록', '미나에게 청월인장을 맡겼다.'],
  ['Japanese unspaced names', '美咲に会う', '庭の記録', '静かな庭で美咲は待っていた。'],
  ['Unicode and case', 'cafe\u0301', 'CAFÉ', 'The keeper opens at dawn.'],
  ['Latin name with Korean particle', 'Mira', '인물 기록', 'Mira에게 비밀을 말했다.'],
  ['Unicode Latin name with Korean particle', 'cafe\u0301', '장소 기록', 'CAFÉ의 문을 잠갔다.'],
  ['Punctuation-only title', '+++', '+++', 'The keeper opens at dawn.'],
])(
  'relevant knowledge search retrieves the reviewed %s reference without unrelated hits',
  (_label, query, title, text) => {
    const fixed = snapshot([
      lore(0, { title: 'Unrelated harbor', description: '', text: 'Ships return at dawn.' }),
      lore(1, { title, description: '', text }),
      lore(2, { chatId: 'foreign-chat', title, description: '', text }),
    ]);
    const event = executeTool(fixed, {
      callId: 'relevant-reviewed',
      name: 'knowledge.search',
      args: { mode: 'relevant', query },
    });
    expect(event.denied).toBe(false);
    expect(event.args).toMatchObject({ mode: 'relevant', query });
    const page = event.result as any;
    expect(page.total).toBe(1);
    expect(page.items.map((item: any) => item.id)).toEqual(['lore-1']);
    expect(page.items[0].nextRead.arguments.ids).toEqual(['lore-1']);
    expect(
      executeTool(fixed, {
        callId: 'relevant-absent',
        name: 'knowledge.search',
        args: { mode: 'relevant', query: 'zqxvutterlyabsent' },
      }).result
    ).toMatchObject({ total: 0, items: [], nextOffset: null });
  }
);

test('relevant search ranks exact identities before incidental prose while preserving literal search and paging', () => {
  const fixed = snapshot([
    lore(0, { title: 'Market', description: '', text: 'Asterion is mentioned in passing.' }),
    lore(1, { title: 'Asterion', description: '', text: 'The keeper guards the ancient seal.' }),
    lore(2, { id: 'Asterion', title: 'Vault record', description: '', text: 'An old brass key.' }),
    lore(3, { title: 'Unrelated', description: '', text: 'Distant orchards.' }),
  ]);
  const search = (args: Record<string, unknown>) =>
    executeTool(fixed, {
      callId: 'rank',
      name: 'knowledge.search',
      args,
    });
  const relevant = search({ mode: 'relevant', query: 'Asterion', limit: 1 });
  expect(relevant.denied).toBe(false);
  const seen: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const event = search({ mode: 'relevant', query: 'Asterion', limit: 1, offset });
    expect(event.denied).toBe(false);
    const page = event.result as any;
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
    seen.push(page.items[0].id);
    offset = page.nextOffset;
  }
  expect(new Set(seen.slice(0, 2))).toEqual(new Set(['lore-1', 'Asterion']));
  expect(seen[2]).toBe('lore-0');
  const metadataHit = (search({ mode: 'relevant', query: 'Asterion' }).result as any).items.find(
    (item: any) => item.id === 'lore-1'
  );
  expect(metadataHit).not.toHaveProperty('match');
  expect(metadataHit.nextRead.arguments.ids).toEqual(['lore-1']);
  for (const mode of [undefined, 'search']) {
    const args = { query: 'Asterion', ...(mode ? { mode } : {}) };
    const literal = search(args);
    expect(literal.denied).toBe(false);
    expect((literal.result as any).items.map((item: any) => item.id)).toEqual(['lore-0', 'lore-1']);
    expect((search({ ...args, query: 'Asterion impossible' }).result as any).total).toBe(0);
    expect(
      (search({ ...args, query: '' }).result as any).items.map((item: any) => item.id)
    ).toEqual(fixed.resources.map((item) => item.id));
  }
  for (const query of ['', '   ']) {
    expect(search({ mode: 'relevant', query })).toMatchObject({
      denied: true,
      result: { code: 'INVALID_ARGUMENTS' },
    });
  }
});

test.each(['CAFÉ 문을 미나에게 맡겼다.', 'CAFE\u0301의 문을 미나에게 맡겼다.'])(
  'relevant search returns exact original late Unicode excerpts and a usable direct read: %s',
  (phrase) => {
    const original = 'İ'.repeat(10_000) + '😀'.repeat(5_000) + phrase;
    const fixed = snapshot([lore(1, { title: 'Vault', description: '', text: original })]);
    const event = executeTool(fixed, {
      callId: 'unicode-relevant',
      name: 'knowledge.search',
      args: { mode: 'relevant', query: 'cafe\u0301' },
    });
    expect(event.denied).toBe(false);
    const hit = (event.result as any).items[0];
    expect(hit.match.text).toContain(phrase);
    expect(hit.match.range.start).toBeGreaterThan(19_000);
    expect(hit.match.text).toBe(original.slice(hit.match.range.start, hit.match.range.end));
    expect(hit.match.text.isWellFormed()).toBe(true);
    const read = executeTool(fixed, {
      callId: 'unicode-direct',
      name: hit.nextRead.name,
      args: hit.nextRead.arguments,
    });
    expect(read.denied).toBe(false);
    expect((read.result as any).items[0].read.text).toContain(phrase);
    expect((read.result as any).items[0].read.source.hash).toBe(hit.match.source.hash);
  }
);

test('automatic catalog ranking uses metadata without scanning reference bodies', () => {
  const resources = [
    lore(0, { title: 'Harbor ledger', description: '' }),
    lore(1, { title: '청월인장', description: '북쪽 탑에 관한 기록.' }),
  ];
  for (const resource of resources)
    Object.defineProperty(resource, 'text', {
      get: () => {
        throw new Error('Automatic catalog ranking must not scan reference bodies');
      },
    });
  const fixed = snapshot(resources);
  fixed.request = '청월인장을 찾아요.';
  expect(buildMainInput(fixed).catalog[0].id).toBe('lore-1');
});

test('main catalog surfaces a late requested reference with fewer tokens and preserves complete discovery', () => {
  const resources = Array.from({ length: 400 }, (_, index) => lore(index));
  resources[399] = lore(399, {
    title: '청월인장',
    description: '미나에게 맡긴 인장과 북쪽 탑의 기록.',
    text: '청월인장은 북쪽 탑에 숨겨져 있다.',
    relatedIds: ['lore-0', 'foreign-id'],
  });
  resources.push(lore(400, { id: 'foreign-id', chatId: 'foreign-chat', title: '청월인장' }));
  const fixed = snapshot(resources);
  fixed.request = '청월인장을 찾아요.';
  const before = structuredClone(fixed);
  const input = buildMainInput(fixed);
  const legacy = resourceCatalog(resources.filter((item) => item.chatId === fixed.chatId));
  const tokens = countTextTokens(JSON.stringify(input.catalog));
  const legacyTokens = countTextTokens(JSON.stringify(legacy.catalog));
  expect(input.catalog[0].id).toBe('lore-399');
  expect(input.catalog[0].relatedIds).toEqual(['lore-0']);
  expect(tokens).toBeLessThanOrEqual(2_000);
  expect(tokens).toBeLessThan(legacyTokens);
  expect(legacy.catalog.map((item) => item.id)).not.toContain('lore-399');
  expect(input.catalogPage!.total).toBe(400);
  expect(buildMainInput(fixed)).toEqual(input);
  const found: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const event = executeTool(fixed, {
      callId: 'discover-all',
      name: 'knowledge.search',
      args: { offset, limit: 100 },
    });
    expect(event.denied).toBe(false);
    const page = event.result as any;
    found.push(...page.items.map((item: any) => item.id));
    offset = page.nextOffset;
  }
  expect(found).toEqual(resources.slice(0, 400).map((item) => item.id));
  const omitted = resources.find(
    (item) => item.chatId === fixed.chatId && !input.catalog.some((listed) => listed.id === item.id)
  )!;
  const read = executeTool(fixed, {
    callId: 'read-omitted',
    name: 'knowledge.read',
    args: { ids: [omitted.id] },
  });
  expect((read.result as any).items[0].read.text).toBe(omitted.text);
  expect(fixed).toEqual(before);
  console.log(
    'MAIN_CATALOG_EVIDENCE',
    JSON.stringify({
      scenario: 'synthetic-400-entry-corpus',
      sourceEntries: 400,
      relevantFirstPage: input.catalog[0].id,
      mainCatalogTokens: tokens,
      defaultCatalogTokens: legacyTokens,
      reachableEntries: found.length,
    })
  );
});

test('an oversized first catalog entry cannot hide a later relevant reference and stays searchable', () => {
  const oversized = lore(0, {
    title: 'Asterion '.repeat(1_100),
    description: '',
    text: 'Asterion archive records.',
  });
  const relevant = lore(1, {
    title: 'Asterion',
    description: 'The keeper and the seal.',
    text: 'The seal lies below the tower.',
  });
  const fixed = snapshot([oversized, relevant]);
  fixed.request = 'Asterion';
  const before = structuredClone(fixed);
  expect(countTextTokens(oversized.title)).toBeGreaterThan(2_000);
  const input = buildMainInput(fixed);
  expect(input.catalog.map((item) => item.id)).toEqual([relevant.id]);
  expect(input.catalogPage).toMatchObject({ total: 2, listed: 1 });
  expect(countTextTokens(JSON.stringify(input.catalog))).toBeLessThanOrEqual(2_000);
  const discover = executeTool(fixed, {
    callId: 'oversized-discovery',
    name: 'knowledge.search',
    args: { query: 'Asterion' },
  });
  expect(discover.denied).toBe(false);
  expect((discover.result as any).items.map((item: any) => item.id)).toEqual([
    oversized.id,
    relevant.id,
  ]);
  const read = executeTool(fixed, {
    callId: 'oversized-read',
    name: 'knowledge.read',
    args: { ids: [oversized.id] },
  });
  expect((read.result as any).items[0].read.text).toBe(oversized.text);
  expect(fixed).toEqual(before);
});
