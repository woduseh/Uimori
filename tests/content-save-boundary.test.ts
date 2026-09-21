import { afterEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Content } from '../core/product.js';
import { validateRisuContent, type RisuContent } from '../core/risu-content.js';
import { Store } from '../server/store.js';

const opened: { store: Store; directory: string }[] = [];
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-content-save-'));
  try {
    const store = new Store(join(directory, 'fixture.sqlite'));
    opened.push({ store, directory });
    return store;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
afterEach(() => {
  for (const { store, directory } of opened.splice(0)) {
    try {
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
function input() {
  const card = {
    name: 'Native title',
    description: 'Native body',
    creator_notes: 'Native notes',
    first_mes: 'Opening scene',
    character_book: { entries: [] },
    extensions: { risuai: {} },
  };
  const pkg: RisuContent = {
    version: 2,
    id: 'incoming',
    revision: 1,
    title: 'Old projection title',
    description: 'Old projection notes',
    body: 'Old projection body',
    lore: [],
    images: [],
    nativeRisu: {
      version: 1,
      card,
      assets: [],
      sourceHash: createHash('sha256').update(JSON.stringify(card)).digest('hex'),
    },
  };
  return {
    kind: 'bot',
    title: 'Outer title',
    description: 'Outer notes',
    text: 'Outer body',
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  };
}
function freeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
}

test('saving projects native fields without mutating borrowed external input', () => {
  const store = database();
  const incoming = input();
  const before = structuredClone(incoming);
  freeze(incoming);
  const saved = store.product.content(incoming) as Content;
  expect(incoming).toEqual(before);
  expect(saved).toMatchObject({
    revision: 1,
    title: 'Native title',
    description: 'Native notes',
    text: 'Native body',
  });
  expect(saved.package).toMatchObject({
    id: saved.id,
    revision: saved.revision,
    title: saved.title,
    description: saved.description,
    body: saved.text,
  });
  expect(saved.package!.nativeRisu).not.toBe(incoming.package.nativeRisu);
  expect(saved.package!.images).not.toBe(incoming.package.images);
  expect(validateRisuContent(saved.package)).toEqual(saved.package);
});

test('returned and caller-owned objects cannot mutate the persisted version', () => {
  const store = database();
  const incoming = input();
  const saved = store.product.content(incoming) as Content;
  incoming.package.nativeRisu.card.description = 'Caller changed';
  saved.package!.nativeRisu.card.description = 'Response changed';
  expect(store.product.get<Content>('content', saved.id).package!.nativeRisu.card.description).toBe(
    'Native body'
  );
});

test.each(['unknown-field', 'invalid-native', 'invalid-projection'] as const)(
  'a %s package still fails without writing a library version',
  (kind) => {
    const store = database();
    const incoming = input();
    if (kind === 'unknown-field') Object.assign(incoming.package, { unknown: true });
    if (kind === 'invalid-native') incoming.package.nativeRisu.sourceHash = 'invalid';
    if (kind === 'invalid-projection') {
      incoming.package.nativeRisu.card.description = 'x'.repeat(1_000_001);
      incoming.package.nativeRisu.sourceHash = createHash('sha256')
        .update(JSON.stringify(incoming.package.nativeRisu.card))
        .digest('hex');
    }
    const before = structuredClone(incoming);
    expect(() => store.product.content(incoming)).toThrow();
    expect(incoming).toEqual(before);
    expect(store.product.all('content')).toEqual([]);
  }
);

test('revision conflicts preserve the saved version and incoming native data', () => {
  const store = database();
  const saved = store.product.content(input()) as Content;
  const incoming = { ...input(), expectedRevision: saved.revision + 1 };
  const before = structuredClone(incoming);
  expect(() => store.product.content(incoming, saved.id)).toThrow('Revision conflict');
  expect(incoming).toEqual(before);
  expect(store.product.get<Content>('content', saved.id)).toEqual(saved);
});

test('in-transaction saves remain owned by the caller transaction', () => {
  const store = database();
  expect(() =>
    store.transaction(() => {
      store.product.content(input(), undefined, true);
      throw new Error('Caller rollback');
    })
  ).toThrow('Caller rollback');
  expect(store.product.all('content')).toEqual([]);
});
