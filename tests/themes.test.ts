import { vi } from 'vitest';
import { describe } from 'vitest';
import { DATABASE_SCHEMA_VERSION } from '../server/database-schema.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { createApp, type App } from '../server/app.js';
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  THEME_COLOR_KEYS,
  defaultThemePreferences,
  normalizeThemePreferences,
  resolvePaletteId,
  emptyTheme,
  parseThemeFile,
  resolveTheme,
  themeDefinition,
  themeFile,
  validateTheme,
} from '../core/themes.js';
import { BUILTIN_PALETTES, THEME_PALETTE_ID } from '../core/theme-palettes.js';
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
  expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(DATABASE_SCHEMA_VERSION);
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
  const chat = store.createChat('Theme chat', { botId: bot.id });
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

describe('Theme catalog revalidation', () => {
  const owners: { directory: string; store: Store; app?: App }[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const owner of owners.splice(0)) {
      if (owner.app) await owner.app.close();
      else owner.store.close();
      rmSync(owner.directory, { recursive: true, force: true });
    }
  });

  async function application() {
    const directory = mkdtempSync(join(tmpdir(), 'uimori-retention-'));
    const app = await createApp({
      dbPath: join(directory, 'app.sqlite'),
      buildId: 'extended-cleanup-test',
      testMode: true,
      codex: { enabled: false },
    });
    owners.push({ directory, store: app.store, app });
    return app;
  }

  test('unchanged theme catalog revalidates without sending definitions, and saves invalidate its ETag', async () => {
    const app = await application();
    const first = await app.inject({ url: '/api/themes' });
    expect(first.statusCode).toBe(200);
    const headers = { 'if-none-match': String(first.headers.etag) };
    const same = await app.inject({ url: '/api/themes', headers });
    expect(same.statusCode).toBe(304);
    expect(same.body).toBe('');
    saveResource(app.store, { kind: 'theme', id: null, model: emptyTheme('New synthetic theme') });
    const changed = await app.inject({ url: '/api/themes', headers });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(first.headers.etag);
  });
});

describe('Independent layout and palette choices', () => {
  function choose(
    store: Store,
    dimension: 'theme' | 'palette',
    id: string | null,
    scope = 'global',
    targetId?: string
  ) {
    return selectTheme(store, {
      dimension,
      [dimension === 'theme' ? 'themeId' : 'paletteId']: id,
      scope,
      targetId,
      expectedRevision: themePreferences(store).revision,
    });
  }

  test('every named palette supplies complete, valid light and dark tokens', () => {
    expect(BUILTIN_PALETTES.map((palette) => palette.id)).toEqual([
      'forest',
      'cream',
      'charcoal',
      'midnight',
      'rose',
      'sage',
    ]);
    for (const palette of BUILTIN_PALETTES) {
      for (const mode of ['light', 'dark'] as const)
        expect(Object.keys(palette.colors[mode]).sort()).toEqual([...THEME_COLOR_KEYS].sort());
      expect(validateTheme({ ...emptyTheme(), colors: palette.colors }).colors).toEqual(
        palette.colors
      );
    }
  });

  test('palette and layout scope inheritance are independent, including explicit theme colors', () => {
    const store = database();
    const bot = store.product.content(fixtureBotInput('Palette bot'));
    const chat = store.createChat('Palette chat', { botId: bot.id });
    const before = JSON.stringify(store.chat(chat.id));
    const custom = save(store);
    const scope = { botId: bot.id, chatId: chat.id };
    choose(store, 'theme', 'builtin:cinematic');
    choose(store, 'palette', 'cream');
    choose(store, 'theme', custom.id, 'chat', chat.id);
    choose(store, 'palette', 'rose', 'bot', bot.id);
    let resolved = resolveTheme(themeCatalog(store), scope);
    expect(resolved.id).toBe(custom.id);
    expect(resolved.colors).toEqual(
      BUILTIN_PALETTES.find((palette) => palette.id === 'rose')!.colors
    );
    expect(resolved.messageCss).toBe(custom.messageCss);
    expect(resolved.templateHtml).toBe(custom.templateHtml);
    expect(resolved.templateCss).toBe(custom.templateCss);
    expect(resolved.appCss).toBe(custom.appCss);
    expect(resolved.revision).toBe(custom.revision);
    expect(readTheme(store, custom.id)).toEqual(custom);

    choose(store, 'palette', 'charcoal', 'chat', chat.id);
    expect(resolvePaletteId(themeCatalog(store), scope)).toBe('charcoal');
    choose(store, 'theme', 'builtin:letter', 'chat', chat.id);
    expect(resolveTheme(themeCatalog(store), scope).id).toBe('builtin:letter');
    expect(resolvePaletteId(themeCatalog(store), scope)).toBe('charcoal');
    choose(store, 'theme', custom.id, 'chat', chat.id);
    choose(store, 'palette', THEME_PALETTE_ID, 'chat', chat.id);
    resolved = resolveTheme(themeCatalog(store), scope);
    expect(resolved).toEqual(custom);
    expect(resolvePaletteId(themeCatalog(store), scope)).toBe(THEME_PALETTE_ID);

    choose(store, 'palette', null, 'chat', chat.id);
    expect(themePreferences(store).chatPalettes).not.toHaveProperty(chat.id);
    expect(resolvePaletteId(themeCatalog(store), scope)).toBe('rose');
    choose(store, 'palette', null, 'bot', bot.id);
    expect(resolvePaletteId(themeCatalog(store), scope)).toBe('cream');
    expect(resolveTheme(themeCatalog(store), scope).id).toBe(custom.id);
    choose(store, 'theme', null, 'chat', chat.id);
    expect(resolveTheme(themeCatalog(store), scope).id).toBe('builtin:cinematic');
    expect(resolvePaletteId(themeCatalog(store), scope)).toBe('cream');
    choose(store, 'palette', null);
    expect(resolvePaletteId(themeCatalog(store), scope)).toBe(THEME_PALETTE_ID);
    expect(JSON.stringify(store.chat(chat.id))).toBe(before);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(0);
  });

  test('missing and unavailable palette selections fall through without changing the layout', () => {
    const base = { themes: BUILTIN_THEMES, preferences: defaultThemePreferences() };
    base.preferences.defaultThemeId = 'builtin:letter';
    base.preferences.defaultPaletteId = 'cream';
    base.preferences.botPalettes = { bot: 'midnight' };
    base.preferences.chatPalettes = { chat: 'unknown' };
    expect(resolvePaletteId(base, { chatId: 'chat', botId: 'bot' })).toBe('midnight');
    expect(resolveTheme(base, { chatId: 'chat', botId: 'bot' }).id).toBe('builtin:letter');
    expect(resolvePaletteId(base, { chatId: 'chat' })).toBe('cream');
    base.preferences.defaultPaletteId = 'unknown';
    expect(resolvePaletteId(base, {})).toBe(THEME_PALETTE_ID);
    delete base.preferences.defaultPaletteId;
    delete base.preferences.botPalettes;
    delete base.preferences.chatPalettes;
    expect(resolveTheme(base, {})).toEqual(
      BUILTIN_THEMES.find((theme) => theme.id === 'builtin:letter')
    );
  });

  test('layout and palette preferences survive restart and resource deletion independently', () => {
    const store = database();
    const custom = save(store);
    const bot = store.product.content(fixtureBotInput('Restart palette'));
    const chat = store.createChat('Restart palette', { botId: bot.id });
    choose(store, 'theme', custom.id);
    choose(store, 'palette', 'cream');
    choose(store, 'palette', 'sage', 'bot', bot.id);
    choose(store, 'palette', 'theme', 'chat', chat.id);
    const before = themePreferences(store);
    store.close();
    const reopened = new Store(store.path);
    owned.at(-1)!.store = reopened;
    expect(themePreferences(reopened)).toEqual(before);
    expect(resolveTheme(themeCatalog(reopened), { botId: bot.id, chatId: chat.id })).toEqual(
      custom
    );
    expect(resolvePaletteId(themeCatalog(reopened), { botId: bot.id })).toBe('sage');
    deleteTheme(reopened, custom.id, custom.revision);
    const after = themePreferences(reopened);
    expect(after.defaultThemeId).toBe(DEFAULT_THEME_ID);
    expect(after.defaultPaletteId).toBe('cream');
    expect(after.botPalettes).toEqual(before.botPalettes);
    expect(after.chatPalettes).toEqual(before.chatPalettes);
  });

  test('selection rejects ambiguous dimensions, invalid IDs, targets and stale cross-dimension writes', () => {
    const store = database();
    const invalid = [
      { dimension: 'palette', paletteId: 'unknown' },
      { dimension: 'palette', paletteId: '' },
      { dimension: 'palette', paletteId: 123 },
      { dimension: 'palette' },
      { paletteId: 'cream' },
      { dimension: 'palette', paletteId: 'cream', themeId: DEFAULT_THEME_ID },
      { dimension: 'theme', themeId: DEFAULT_THEME_ID, paletteId: null },
      { dimension: 'other', paletteId: 'cream' },
      { dimension: 'palette', paletteId: 'cream', scope: 'other' },
      { dimension: 'palette', paletteId: 'cream', scope: 'chat', targetId: 'missing' },
      { dimension: 'palette', paletteId: 'cream', scope: 'bot', targetId: 'missing' },
    ];
    for (const input of invalid) {
      expect(() =>
        selectTheme(store, { scope: 'global', expectedRevision: 0, ...input })
      ).toThrow();
      expect(themePreferences(store).revision).toBe(0);
    }
    choose(store, 'palette', 'cream');
    expect(() =>
      selectTheme(store, {
        scope: 'global',
        themeId: 'builtin:letter',
        expectedRevision: 0,
      })
    ).toThrow();
    expect(themePreferences(store).defaultThemeId).toBe(DEFAULT_THEME_ID);
    choose(store, 'theme', 'builtin:letter');
    expect(() =>
      selectTheme(store, {
        scope: 'global',
        dimension: 'palette',
        paletteId: 'rose',
        expectedRevision: 1,
      })
    ).toThrow();
    expect(themePreferences(store).defaultPaletteId).toBe('cream');
  });

  test('legacy palette-only presets migrate with custom color boundaries and no resource writes', () => {
    const store = database();
    const custom = save(store, 'Liquid Gallery');
    const beforeCustom = readTheme(store, custom.id);
    const legacy = {
      revision: 7,
      defaultThemeId: 'builtin:midnight',
      botThemes: { forest: DEFAULT_THEME_ID, rose: 'builtin:blossom', paper: 'builtin:library' },
      chatThemes: { custom: custom.id, gallery: 'builtin:liquid-gallery' },
    };
    const raw = JSON.stringify(legacy);
    store.db
      .prepare('INSERT INTO app_metadata(key,value) VALUES(?,?)')
      .run('theme-preferences', raw);
    const p = themePreferences(store);
    expect(p).toMatchObject({
      revision: 7,
      defaultThemeId: DEFAULT_THEME_ID,
      defaultPaletteId: 'midnight',
      botThemes: { forest: DEFAULT_THEME_ID, rose: DEFAULT_THEME_ID, paper: 'builtin:library' },
      botPalettes: { forest: 'theme', rose: 'rose', paper: 'theme' },
      chatThemes: { custom: custom.id, gallery: 'builtin:cinematic' },
      chatPalettes: { custom: 'theme', gallery: 'theme' },
    });
    expect(normalizeThemePreferences(p)).toEqual(p);
    expect(legacy.defaultThemeId).toBe('builtin:midnight');
    expect(
      store.db.prepare('SELECT value FROM app_metadata WHERE key=?').get('theme-preferences')?.value
    ).toBe(raw);
    expect(resolveTheme(themeCatalog(store), { chatId: 'custom' })).toEqual(beforeCustom);
    expect(resolveTheme(themeCatalog(store), {}).colors.light.accent).toBe('#305d9e');
    expect(resolveTheme(themeCatalog(store), { botId: 'rose' }).colors.light.accent).toBe(
      '#934a6c'
    );
    expect(resolveTheme(themeCatalog(store), { botId: 'paper' }).templateHtml).toContain(
      'class="paper"'
    );
    expect(readTheme(store, 'builtin:liquid-gallery').id).toBe('builtin:cinematic');
    expect(readTheme(store, 'builtin:midnight').colors.light.accent).toBe('#305d9e');
    expect(readTheme(store, custom.id)).toEqual(beforeCustom);
    expect(BUILTIN_THEMES.map((theme) => theme.id)).toEqual([
      DEFAULT_THEME_ID,
      'builtin:cinematic',
      'builtin:letter',
      'builtin:scrapbook',
    ]);
    choose(store, 'palette', 'sage');
    const saved = themePreferences(store);
    store.close();
    const reopened = new Store(store.path);
    owned.at(-1)!.store = reopened;
    expect(themePreferences(reopened)).toEqual(saved);
    expect(resolveTheme(themeCatalog(reopened), { chatId: 'custom' })).toEqual(beforeCustom);
  });

  test('existing independent choices are preserved when retired IDs are normalized or selected', () => {
    const store = database();
    const preferences = normalizeThemePreferences({
      ...defaultThemePreferences(),
      defaultThemeId: 'builtin:liquid-gallery',
      defaultPaletteId: 'sage',
      botThemes: { bot: 'builtin:midnight' },
      botPalettes: { bot: 'cream' },
    });
    expect(preferences.defaultThemeId).toBe('builtin:cinematic');
    expect(preferences.defaultPaletteId).toBe('sage');
    expect(preferences.botThemes.bot).toBe(DEFAULT_THEME_ID);
    expect(preferences.botPalettes?.bot).toBe('cream');
    choose(store, 'palette', 'rose');
    choose(store, 'theme', 'builtin:midnight');
    expect(themePreferences(store).defaultThemeId).toBe(DEFAULT_THEME_ID);
    expect(themePreferences(store).defaultPaletteId).toBe('rose');
    choose(store, 'theme', 'builtin:liquid-gallery');
    expect(themePreferences(store).defaultThemeId).toBe('builtin:cinematic');
    expect(themePreferences(store).defaultPaletteId).toBe('rose');
  });

  test('HTTP palette selection invalidates the catalog and exposes validation and revision conflicts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'uimori-palette-api-'));
    const app = await createApp({
      dbPath: join(directory, 'app.sqlite'),
      buildId: 'palettes-test',
      testMode: true,
      codex: { enabled: false },
    });
    owned.push({ directory, store: app.store, app });
    const first = await app.inject('/api/themes');
    const selected = await app.inject({
      method: 'POST',
      url: '/api/themes/selection',
      payload: { dimension: 'palette', scope: 'global', paletteId: 'cream', expectedRevision: 0 },
    });
    expect(selected.statusCode, selected.body).toBe(200);
    expect(selected.json()).toMatchObject({
      revision: 1,
      defaultThemeId: DEFAULT_THEME_ID,
      defaultPaletteId: 'cream',
    });
    const changed = await app.inject({
      url: '/api/themes',
      headers: { 'if-none-match': String(first.headers.etag) },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(first.headers.etag);
    expect(
      (
        await app.inject({
          url: '/api/themes',
          headers: { 'if-none-match': String(changed.headers.etag) },
        })
      ).statusCode
    ).toBe(304);
    const stale = await app.inject({
      method: 'POST',
      url: '/api/themes/selection',
      payload: { scope: 'global', themeId: 'builtin:letter', expectedRevision: 0 },
    });
    expect(stale.statusCode).toBe(409);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/themes/selection',
      payload: { dimension: 'palette', scope: 'global', paletteId: 'bogus', expectedRevision: 1 },
    });
    expect(invalid.statusCode).toBe(400);
    const mixed = await app.inject({
      method: 'POST',
      url: '/api/themes/selection',
      payload: {
        dimension: 'palette',
        scope: 'global',
        paletteId: 'cream',
        themeId: DEFAULT_THEME_ID,
        expectedRevision: 1,
      },
    });
    expect(mixed.statusCode).toBe(400);
  });
});
