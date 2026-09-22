import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { createApp, type App } from '../server/app.js';
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  emptyTheme,
  parseThemeFile,
  resolveTheme,
  themeDefinition,
  themeFile,
  validateTheme,
} from '../core/themes.js';
import {
  themeCatalog,
  themePreferences,
  selectTheme,
  deleteTheme,
  readTheme,
} from '../server/themes.js';
import { saveResource, undoResource } from '../server/resource-service.js';
import { invokeResourceTool } from '../server/helper-resource-tools.js';
import { fixtureBotInput } from './fixtures/chat.js';

const owned: { directory: string; store: Store; app?: App }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    if (item.app) await item.app.close();
    else item.store.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-themes-'));
  const store = new Store(join(directory, 'app.sqlite'));
  owned.push({ directory, store });
  return store;
}
function save(store: Store, title = 'Custom') {
  return saveResource(store, {
    kind: 'theme',
    id: null,
    model: {
      ...emptyTheme(title),
      colors: { light: { accent: '#123456' }, dark: { accent: '#abcdef' } },
      messageCss: 'p { letter-spacing: .02em; }',
    },
  }).saved as import('../core/themes.js').Theme;
}
test('portable definitions preserve styles but never import identities or choose a theme', () => {
  for (const builtin of BUILTIN_THEMES)
    expect(parseThemeFile(themeFile(themeDefinition(builtin)))).toEqual(themeDefinition(builtin));
  expect(
    parseThemeFile({
      ...themeFile(emptyTheme()),
      theme: { ...emptyTheme(), id: 'existing', revision: 99 },
    })
  ).not.toHaveProperty('id');
  expect(() => parseThemeFile({ format: 'risu', version: 1 })).toThrow();
  expect(() => parseThemeFile({ format: 'uimori-theme', version: 2 })).toThrow();
  expect(() => validateTheme({ ...emptyTheme(), title: ' ' })).toThrow();
  expect(() =>
    validateTheme({ ...emptyTheme(), colors: { light: { accent: 'red;display:none' } } })
  ).toThrow();
  expect(() =>
    validateTheme({ ...emptyTheme(), colors: { light: { unknown: '#000000' } } })
  ).toThrow();
  expect(() => validateTheme({ ...emptyTheme(), templateHtml: 'x'.repeat(100001) })).toThrow();
});
test('themes, choices and undo persist across SQLite restart without a schema migration', () => {
  const store = database();
  const a = save(store);
  const b = save(store, 'Another');
  const changed = saveResource(store, {
    kind: 'theme',
    id: a.id,
    expectedRevision: a.revision,
    model: { ...themeDefinition(a), title: 'Edited' },
  }).saved;
  expect(() =>
    saveResource(store, {
      kind: 'theme',
      id: a.id,
      expectedRevision: a.revision,
      model: emptyTheme(),
    })
  ).toThrow();
  expect(undoResource(store, 'theme', a.id, changed.revision).saved).toMatchObject({
    title: 'Custom',
    revision: 3,
  });
  selectTheme(store, { scope: 'global', themeId: b.id, expectedRevision: 0 });
  expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
  store.close();
  const reopened = new Store(store.path);
  owned.at(-1)!.store = reopened;
  expect(themeCatalog(reopened).themes).toHaveLength(BUILTIN_THEMES.length + 2);
  expect(resolveTheme(themeCatalog(reopened), {}).id).toBe(b.id);
  expect(readTheme(reopened, a.id).title).toBe('Custom');
});
test('chat overrides bot overrides global; deleting a theme removes only its appearance references', () => {
  const store = database();
  const bot = store.product.content(fixtureBotInput('Theme bot'));
  const chat = store.createChat('Theme chat', undefined, { botId: bot.id });
  const before = JSON.stringify(store.chat(chat.id));
  const a = save(store, 'Global');
  const b = save(store, 'Bot');
  const c = save(store, 'Chat');
  const choose = (scope: string, themeId: string | null, targetId?: string) =>
    selectTheme(store, {
      scope,
      themeId,
      targetId,
      expectedRevision: themePreferences(store).revision,
    });
  choose('global', a.id);
  choose('bot', b.id, bot.id);
  choose('chat', c.id, chat.id);
  const scope = { botId: bot.id, chatId: chat.id };
  expect(resolveTheme(themeCatalog(store), scope).id).toBe(c.id);
  deleteTheme(store, c.id, c.revision);
  expect(resolveTheme(themeCatalog(store), scope).id).toBe(b.id);
  choose('bot', null, bot.id);
  expect(resolveTheme(themeCatalog(store), scope).id).toBe(a.id);
  deleteTheme(store, a.id, a.revision);
  expect(resolveTheme(themeCatalog(store), scope).id).toBe(DEFAULT_THEME_ID);
  expect(JSON.stringify(store.chat(chat.id))).toBe(before);
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(0);
  expect(() => choose('bot', b.id, 'missing')).toThrow();
});
test('built-ins cannot be edited or deleted; stale preference writes fail', () => {
  const store = database();
  expect(() =>
    saveResource(store, {
      kind: 'theme',
      id: DEFAULT_THEME_ID,
      expectedRevision: 1,
      model: emptyTheme(),
    })
  ).toThrow();
  expect(() => deleteTheme(store, DEFAULT_THEME_ID, 1)).toThrow();
  selectTheme(store, { scope: 'global', themeId: 'builtin:library', expectedRevision: 0 });
  expect(() =>
    selectTheme(store, { scope: 'global', themeId: DEFAULT_THEME_ID, expectedRevision: 0 })
  ).toThrow();
  expect(
    resolveTheme(
      {
        ...themeCatalog(store),
        preferences: { ...themePreferences(store), chatThemes: { stale: 'missing' } },
      },
      { chatId: 'stale' }
    ).id
  ).toBe('builtin:library');
});
test('helper uses the same save, guide, list and undo contract without changing selection', () => {
  const store = database();
  expect(invokeResourceTool(store, 'theme.guide', {})).toMatchObject({
    slots: ['request', 'heading', 'body', 'actions'],
  });
  const result = invokeResourceTool(store, 'resource.save', {
    kind: 'theme',
    model: emptyTheme('Helper theme'),
  }) as { id: string; revision: number };
  expect(
    invokeResourceTool(store, 'resource.read', { kind: 'theme', id: result.id })
  ).toMatchObject({ title: 'Helper theme' });
  expect(
    (invokeResourceTool(store, 'theme.list', {}) as { themes: unknown[] }).themes
  ).toHaveLength(BUILTIN_THEMES.length + 1);
  expect(themePreferences(store).defaultThemeId).toBe(DEFAULT_THEME_ID);
  invokeResourceTool(store, 'resource.delete', {
    kind: 'theme',
    id: result.id,
    expectedRevision: result.revision,
  });
  expect(() => readTheme(store, result.id)).toThrow();
});
test('HTTP API saves, exports, selects, validates and deletes a theme', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-theme-api-'));
  const app = await createApp({
    dbPath: join(directory, 'app.sqlite'),
    buildId: 'themes-test',
    testMode: true,
  });
  owned.push({ directory, store: app.store, app });
  const saved = await app.inject({
    method: 'POST',
    url: '/api/resources/save',
    payload: { kind: 'theme', model: emptyTheme('API theme') },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const theme = saved.json().saved;
  expect((await app.inject(`/api/themes/${theme.id}/export`)).json()).toMatchObject({
    format: 'uimori-theme',
    version: 1,
    theme: { title: 'API theme' },
  });
  const selected = await app.inject({
    method: 'POST',
    url: '/api/themes/selection',
    payload: { scope: 'global', themeId: theme.id, expectedRevision: 0 },
  });
  expect(selected.statusCode, selected.body).toBe(200);
  const invalid = await app.inject({
    method: 'POST',
    url: '/api/resources/save',
    payload: { kind: 'theme', model: { title: '' } },
  });
  expect(invalid.statusCode).toBe(400);
  const deleted = await app.inject({
    method: 'DELETE',
    url: `/api/themes/${theme.id}`,
    payload: { expectedRevision: 1 },
  });
  expect(deleted.statusCode, deleted.body).toBe(200);
  expect((await app.inject('/api/themes')).json().preferences.defaultThemeId).toBe(
    DEFAULT_THEME_ID
  );
});
