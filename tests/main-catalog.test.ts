import { expect, test } from 'vitest';
import {
  buildMainInput,
  CATALOG_CHARS,
  CATALOG_READ_GUIDANCE,
  CATALOG_SUMMARY_CHARS,
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
    settings: { preset: 'calm', mode: 'direct', translation: false, status: false, maxCalls: 4 },
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
