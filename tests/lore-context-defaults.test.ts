import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LORE_CONTEXT } from '../core/lore-context.js';
import { Store } from '../server/store.js';
import { loreContextDefaults, updateLoreContextDefaults } from '../server/lore-context-defaults.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { directory: string; store: Store }[] = [];
afterEach(() => {
  for (const item of owned.splice(0).reverse()) {
    item.store.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

function database() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-lore-defaults-'));
  const store = new Store(join(directory, 'test.sqlite'));
  owned.push({ directory, store });
  return store;
}

test('new chats copy the current token defaults without following later changes', () => {
  const store = database();
  expect(loreContextDefaults(store)).toEqual({ revision: 1, ...DEFAULT_LORE_CONTEXT });
  const first = createFixtureChat(store, 'First');
  const saved = updateLoreContextDefaults(store, {
    expectedRevision: 1,
    ...DEFAULT_LORE_CONTEXT,
    maxRetainedTokens: 24_000,
    maxPinnedTokens: 96_000,
  });
  expect(saved.revision).toBe(2);
  const second = createFixtureChat(store, 'Second');
  expect(store.product.profile(first.id).loreContext).toEqual(DEFAULT_LORE_CONTEXT);
  expect(store.product.profile(second.id).loreContext).toEqual({
    ...DEFAULT_LORE_CONTEXT,
    maxRetainedTokens: 24_000,
    maxPinnedTokens: 96_000,
  });
});

test('default updates use revision conflicts and survive archive restore', () => {
  const source = database();
  updateLoreContextDefaults(source, {
    expectedRevision: 1,
    ...DEFAULT_LORE_CONTEXT,
    maxRetainedEntries: 32,
  });
  expect(() =>
    updateLoreContextDefaults(source, {
      expectedRevision: 1,
      ...DEFAULT_LORE_CONTEXT,
    })
  ).toThrow('로어 문맥 기본값이 변경됐어요');
  createFixtureChat(source, 'Archive owner');
  const target = database();
  expect(target.product.import(source.product.export()).restored).toBe(true);
  expect(loreContextDefaults(target)).toEqual(loreContextDefaults(source));
});

test('customized defaults count as data and cannot be overwritten by restore', () => {
  const source = database();
  createFixtureChat(source, 'Archive owner');
  const target = database();
  updateLoreContextDefaults(target, {
    expectedRevision: 1,
    ...DEFAULT_LORE_CONTEXT,
    maxRetainedTokens: 24_000,
  });
  expect(target.product.importStatus()).toEqual({ canImport: false });
  expect(() => target.product.import(source.product.export())).toThrow(
    'Restore requires an empty database'
  );
  expect(loreContextDefaults(target).maxRetainedTokens).toBe(24_000);
});
