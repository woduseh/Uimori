import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { selectTheme, selectThemeBackground, themePreferences } from '../server/themes.js';
import {
  resolveThemeBackground,
  defaultThemeBackground,
  validateThemeBackground,
} from '../core/theme-background.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { pruneUnusedData } from '../server/unused-data.js';
const owned: { directory: string; store: Store }[] = [];
afterEach(() => {
  for (const item of owned.splice(0)) {
    item.store.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-background-'));
  const store = new Store(join(directory, 'app.sqlite'));
  owned.push({ directory, store });
  return store;
}
const hash = 'a'.repeat(64);
const image = {
  ...defaultThemeBackground,
  imageHash: hash,
  blur: 8,
  lightOverlay: 20,
  darkOverlay: 60,
};
test('background scopes are independent; explicit clear blocks inheritance; preferences survive restart', () => {
  const store = database();
  store.db
    .prepare('INSERT INTO image_blobs VALUES(?,?,?)')
    .run(hash, 'image/webp', Buffer.from('fixture'));
  const bot = store.product.content(fixtureBotInput('Background bot'));
  const chat = store.createChat('Background chat', { botId: bot.id });
  const before = JSON.stringify(store.chat(chat.id));
  const choose = (scope: string, background: unknown, targetId?: string) =>
    selectThemeBackground(store, {
      scope,
      targetId,
      background,
      expectedRevision: themePreferences(store).revision,
    });
  choose('global', image);
  choose('bot', { ...image, blur: 12 }, bot.id);
  choose('chat', { ...defaultThemeBackground }, chat.id);
  const scope = { botId: bot.id, chatId: chat.id };
  expect(resolveThemeBackground(themePreferences(store), scope).imageHash).toBeNull();
  choose('chat', null, chat.id);
  expect(resolveThemeBackground(themePreferences(store), scope).blur).toBe(12);
  selectTheme(store, {
    scope: 'global',
    themeId: 'builtin:letter',
    expectedRevision: themePreferences(store).revision,
  });
  selectTheme(store, {
    scope: 'global',
    dimension: 'palette',
    paletteId: 'rose',
    expectedRevision: themePreferences(store).revision,
  });
  expect(resolveThemeBackground(themePreferences(store), scope).blur).toBe(12);
  choose('bot', null, bot.id);
  expect(resolveThemeBackground(themePreferences(store), scope)).toEqual(image);
  expect(JSON.stringify(store.chat(chat.id))).toBe(before);
  expect(themePreferences(store).defaultThemeId).toBe('builtin:letter');
  expect(themePreferences(store).defaultPaletteId).toBe('rose');
  store.close();
  const reopened = new Store(store.path);
  owned.at(-1)!.store = reopened;
  expect(resolveThemeBackground(themePreferences(reopened), scope)).toEqual(image);
});
test('background validation rejects invalid numbers, external URLs, missing blobs and stale writes', () => {
  const store = database();
  for (const patch of [
    { blur: -1 },
    { blur: 31 },
    { blur: 1.5 },
    { darkOverlay: 101 },
    { lightOverlay: -1 },
    { imageHash: 'https://example.com/image.jpg' },
    { url: 'x' },
  ])
    expect(() => validateThemeBackground({ ...image, ...patch })).toThrow();
  expect(() =>
    selectThemeBackground(store, { scope: 'global', background: image, expectedRevision: 0 })
  ).toThrow('업로드');
  selectThemeBackground(store, {
    scope: 'global',
    background: defaultThemeBackground,
    expectedRevision: 0,
  });
  expect(() =>
    selectThemeBackground(store, { scope: 'global', background: null, expectedRevision: 0 })
  ).toThrow('다른 창');
  expect(themePreferences(store).revision).toBe(1);
});
test('image cleanup retains active background bytes without retaining cleared backgrounds forever', () => {
  const store = database();
  store.db
    .prepare('INSERT INTO image_blobs VALUES(?,?,?)')
    .run(hash, 'image/webp', Buffer.from('fixture'));
  selectThemeBackground(store, { scope: 'global', background: image, expectedRevision: 0 });
  pruneUnusedData(store.db, [hash]);
  expect(store.db.prepare('SELECT 1 FROM image_blobs WHERE hash=?').get(hash)).toBeTruthy();
  selectThemeBackground(store, { scope: 'global', background: null, expectedRevision: 1 });
  pruneUnusedData(store.db, [hash]);
  expect(store.db.prepare('SELECT 1 FROM image_blobs WHERE hash=?').get(hash)).toBeUndefined();
});
