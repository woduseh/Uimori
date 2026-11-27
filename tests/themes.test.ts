import { describe } from 'vitest';
import { DATABASE_SCHEMA_VERSION } from '../server/database-schema.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { createApp, type App } from '../server/app.js';
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  THEME_COLOR_KEYS,
  THEME_TITLE_MAX_CHARS,
  copyTitle,
  defaultThemePreferences,
  resolvePaletteId,
  emptyTheme,
  parseThemeFile,
  resolveTheme,
  themeDefinition,
  themeFile,
  validateTheme,
} from '../core/themes.js';
import {
  BUILTIN_PALETTES,
  DEFAULT_PALETTE_COLORS,
  THEME_PALETTE_ID,
} from '../core/theme-palettes.js';
import {
  themeCatalog,
  themePreferences,
  selectTheme,
  deleteTheme,
  readTheme,
} from '../server/themes.js';
import { saveResource, undoResource } from '../server/resource-service.js';
import { invokeResourceTool } from '../server/helper-resource-tools.js';
import { invokePresentationTool } from '../server/helper-presentation-tools.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { appearanceOperations, type SelectThemeRequest } from '#contracts/operations';
import { parseInput } from '../server/endpoint.js';

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
  for (const builtin of BUILTIN_THEMES) {
    const files = (builtin.assets ?? []).map(({ hash, kind }) => ({
      hash,
      kind,
      mime: '',
      data: '',
    }));
    expect(parseThemeFile(themeFile(themeDefinition(builtin), files)).theme).toEqual(
      themeDefinition(builtin)
    );
  }
  expect(
    parseThemeFile({
      ...themeFile(emptyTheme()),
      theme: { ...emptyTheme(), id: 'existing', revision: 99 },
    }).theme
  ).not.toHaveProperty('id');
  expect(() => parseThemeFile({ format: 'risu', version: 1 })).toThrow();
  expect(() => parseThemeFile({ format: 'uimori-theme', version: 3 })).toThrow();
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
  const choose = (scope: SelectThemeRequest['scope'], themeId: string | null, targetId?: string) =>
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
  const shown = themePreferences(store).revision;
  deleteTheme(store, c.id, c.revision);
  expect(() =>
    selectTheme(store, { scope: 'global', themeId: c.id, expectedRevision: shown })
  ).toThrow('REVISION_CONFLICT');
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
  selectTheme(store, { scope: 'global', themeId: 'builtin:letter', expectedRevision: 0 });
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
  ).toBe('builtin:letter');
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
test('helper theme discovery omits styles while exact reads and guarded selection retain them', () => {
  const store = database();
  const saved = save(store, 'Discoverable theme');
  const before = themeCatalog(store);
  const catalog = invokeResourceTool(store, 'theme.list', {}) as {
    themes: { id: string }[];
    palettes: { id: string }[];
    preferences: ReturnType<typeof themePreferences>;
  };
  expect(catalog.themes.find((theme) => theme.id === saved.id)).toEqual({
    id: saved.id,
    revision: saved.revision,
    title: 'Discoverable theme',
    description: saved.description,
  });
  for (const entry of catalog.themes)
    expect(Object.keys(entry).sort()).toEqual(['description', 'id', 'revision', 'title']);
  expect(catalog.palettes).toEqual(
    before.palettes?.map(({ colors: _colors, ...metadata }) => metadata)
  );
  expect(catalog.preferences).toEqual(before.preferences);
  expect(themeCatalog(store)).toEqual(before);

  expect(
    invokeResourceTool(store, 'resource.read', {
      kind: 'theme',
      id: saved.id,
      path: '/messageCss',
    })
  ).toMatchObject({ id: saved.id, revision: saved.revision, text: saved.messageCss });
  const builtin = BUILTIN_THEMES.find((theme) => theme.templateHtml.length > 0)!;
  expect(
    invokeResourceTool(store, 'resource.read', {
      kind: 'theme',
      id: builtin.id,
      path: '/templateHtml',
      textLimit: 10000,
    })
  ).toMatchObject({ text: builtin.templateHtml, nextOffset: null });
  expect(
    invokeResourceTool(store, 'resource.read', {
      kind: 'theme',
      id: saved.id,
      path: '/colors/light/accent',
    })
  ).toMatchObject({ text: '#123456' });
  expect(invokePresentationTool(store, 'palette.list', {})).toEqual({
    palettes: before.palettes,
    preferences: before.preferences,
  });
  expect(
    invokePresentationTool(store, 'theme.select', {
      scope: 'global',
      dimension: 'theme',
      themeId: saved.id,
      expectedRevision: catalog.preferences.revision,
    })
  ).toMatchObject({ defaultThemeId: saved.id, revision: catalog.preferences.revision + 1 });
});

test('HTTP API revalidates the catalog, saves, exports, selects, validates and deletes a theme', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-theme-api-'));
  const app = await createApp({
    dbPath: join(directory, 'app.sqlite'),
    buildId: 'themes-test',
    testMode: true,
  });
  owned.push({ directory, store: app.store, app });
  const first = await app.inject({ url: '/api/themes' });
  const cached = { 'if-none-match': String(first.headers.etag) };
  const same = await app.inject({ url: '/api/themes', headers: cached });
  expect(same.statusCode).toBe(304);
  expect(same.body).toBe('');
  const saved = await app.inject({
    method: 'POST',
    url: '/api/resources/save',
    payload: { kind: 'theme', model: emptyTheme('API theme') },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  expect((await app.inject({ url: '/api/themes', headers: cached })).statusCode).toBe(200);
  const theme = saved.json().saved;
  expect(themeFile(theme)).toMatchObject({
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

test('a stale tab gets a revision conflict or a catalogued code for themes and palettes changed elsewhere', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-theme-stale-'));
  const app = await createApp({
    dbPath: join(directory, 'app.sqlite'),
    buildId: 'themes-stale-test',
    testMode: true,
  });
  owned.push({ directory, store: app.store, app });
  const bot = app.store.product.content(fixtureBotInput('Stale bot'));
  const paletteModel = { title: 'Palette', description: '', colors: { light: {}, dark: {} } };
  const palette = (
    await app.inject({ method: 'POST', url: '/api/palettes', payload: { model: paletteModel } })
  ).json();
  const removePalette = {
    method: 'DELETE',
    url: `/api/palettes/${palette.id}`,
    payload: { expectedRevision: palette.revision },
  } as const;
  expect((await app.inject(removePalette)).statusCode).toBe(200);
  const storyModel = { ...emptyTheme('Story'), storyUi: { baseStyle: 'period', css: '' } };
  const theme = (
    await app.inject({
      method: 'POST',
      url: '/api/resources/save',
      payload: { kind: 'theme', model: storyModel },
    })
  ).json().saved;
  const removeTheme = {
    method: 'DELETE',
    url: `/api/themes/${theme.id}`,
    payload: { expectedRevision: theme.revision },
  } as const;
  const shown = themePreferences(app.store).revision;
  const plain = await app.inject({
    method: 'POST',
    url: '/api/resources/save',
    payload: {
      kind: 'theme',
      id: theme.id,
      expectedRevision: theme.revision,
      model: emptyTheme('Story'),
    },
  });
  expect(plain.statusCode, plain.body).toBe(200);
  const storyUi = await app.inject({
    method: 'POST',
    url: '/api/themes/selection',
    payload: {
      dimension: 'storyUi',
      scope: 'bot',
      targetId: bot.id,
      themeId: theme.id,
      expectedRevision: shown,
    },
  });
  expect(storyUi.statusCode).toBe(400);
  expect(storyUi.json()).toEqual({ code: 'THEME_STORY_UI_MISSING' });
  expect(
    (
      await app.inject({
        ...removeTheme,
        payload: { expectedRevision: plain.json().saved.revision },
      })
    ).statusCode
  ).toBe(200);
  for (const request of [
    {
      method: 'PUT',
      url: `/api/palettes/${palette.id}`,
      payload: { model: paletteModel, expectedRevision: palette.revision },
    },
    removePalette,
    removeTheme,
    {
      method: 'POST',
      url: '/api/themes/selection',
      payload: { scope: 'chat', targetId: 'deleted-chat', themeId: null, expectedRevision: shown },
    },
    {
      method: 'POST',
      url: '/api/themes/background',
      payload: {
        scope: 'chat',
        targetId: 'deleted-chat',
        background: null,
        expectedRevision: shown,
      },
    },
  ] as const) {
    const response = await app.inject(request);
    expect(response.statusCode, `${request.method} ${request.url}`).toBe(409);
    expect(response.json()).toEqual({ code: 'REVISION_CONFLICT' });
  }
});

test('a copied title keeps its suffix within the title limit', () => {
  const long = '가'.repeat(THEME_TITLE_MAX_CHARS - 1);
  for (const title of [long, `${'a'.repeat(THEME_TITLE_MAX_CHARS - 4)}  😀😀`, 'Short']) {
    const copied = copyTitle(title, ' 사본');
    expect(copied.endsWith(' 사본'), title).toBe(true);
    expect(validateTheme({ ...emptyTheme(), title: copied }).title).toBe(copied);
  }
  expect(copyTitle('Short', ' copy')).toBe('Short copy');
});

test('portable story UI themes use their own bot selection and the shared revisions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-story-ui-theme-api-'));
  const app = await createApp({
    dbPath: join(directory, 'app.sqlite'),
    buildId: 'story-ui-theme-test',
    testMode: true,
    codex: { enabled: false },
  });
  owned.push({ directory, store: app.store, app });
  const bot = app.store.product.content(fixtureBotInput('Story UI bot'));
  const otherBot = app.store.product.content(fixtureBotInput('Other bot'));
  const persona = app.store.product.content({
    kind: 'persona',
    title: 'Persona',
    description: '',
    text: 'Synthetic persona',
    loading: 'pinned',
    relatedIds: [],
  });
  const chat = app.store.createChat('Story UI chat', { botId: bot.id });
  const model = {
    title: 'Custom story UI',
    storyUi: {
      baseStyle: 'period',
      css: '\n@media (width > 40rem) { :host { --accent: #d32; } }\n',
    },
  };
  const save = (model: unknown, id?: string, expectedRevision?: number) =>
    app.inject({
      method: 'POST',
      url: '/api/resources/save',
      payload: { kind: 'theme', model, id, expectedRevision },
    });
  const created = await save(model);
  expect(created.statusCode, created.body).toBe(200);
  const theme = created.json().saved;
  expect(theme.storyUi).toEqual(model.storyUi);
  const portable = parseThemeFile(themeFile(theme)).theme;
  expect(portable).toMatchObject(model);
  const imported = (await save(portable)).json().saved;
  expect(imported.id).not.toBe(theme.id);
  expect(imported.storyUi).toEqual(model.storyUi);
  expect(
    (await save({ ...model, storyUi: { ...model.storyUi, baseStyle: 'auto' } })).statusCode
  ).toBe(400);
  const updated = await save({ ...portable, title: 'Edited' }, theme.id, theme.revision);
  expect(updated.statusCode, updated.body).toBe(200);
  expect(updated.json().saved.storyUi).toEqual(model.storyUi);
  expect((await save(portable, theme.id, theme.revision)).statusCode).toBe(409);
  const boarded = {
    ...model,
    storyUi: { ...model.storyUi, boardCss: '& { --board-paper: #202228; }' },
  };
  const withBoard = (await save(boarded)).json().saved;
  expect(withBoard.storyUi).toEqual(boarded.storyUi);
  const boardFile = parseThemeFile(themeFile(withBoard)).theme;
  expect(boardFile.storyUi).toEqual(boarded.storyUi);

  selectTheme(app.store, {
    scope: 'bot',
    targetId: bot.id,
    themeId: 'builtin:letter',
    expectedRevision: 0,
  });
  selectTheme(app.store, {
    scope: 'global',
    dimension: 'palette',
    paletteId: 'cream',
    expectedRevision: 1,
  });
  const original = await app.inject('/api/themes');
  const choose = (
    themeId: string | null,
    expectedRevision: number,
    targetId = bot.id,
    scope = 'bot'
  ) =>
    app.inject({
      method: 'POST',
      url: '/api/themes/selection',
      payload: { dimension: 'storyUi', scope, targetId, themeId, expectedRevision },
    });
  expect((await choose(theme.id, 2, bot.id, 'global')).statusCode).toBe(400);
  expect((await choose(theme.id, 2, chat.id, 'chat')).statusCode).toBe(400);
  expect((await choose(theme.id, 2, persona.id)).statusCode).toBe(400);
  expect((await choose(DEFAULT_THEME_ID, 2)).statusCode).toBe(400);
  const selected = await choose(theme.id, 2);
  expect(selected.statusCode, selected.body).toBe(200);
  expect(selected.json()).toMatchObject({
    revision: 3,
    botStoryUiThemes: { [bot.id]: theme.id },
    botThemes: { [bot.id]: 'builtin:letter' },
    defaultPaletteId: 'cream',
  });
  const changed = await app.inject({
    url: '/api/themes',
    headers: { 'if-none-match': String(original.headers.etag) },
  });
  expect(changed.statusCode).toBe(200);
  expect(changed.json().preferences).toEqual(selected.json());
  expect((await choose(null, 2)).statusCode).toBe(409);
  expect((await choose(null, 3)).json().botStoryUiThemes).toEqual({});
  expect((await choose(theme.id, 4)).statusCode).toBe(200);
  expect((await choose(imported.id, 5, otherBot.id)).statusCode).toBe(200);
  deleteTheme(app.store, theme.id, updated.json().saved.revision);
  const preferences = themePreferences(app.store);
  expect(preferences.botStoryUiThemes).toEqual({ [otherBot.id]: imported.id });
  expect(preferences).toMatchObject({
    botThemes: { [bot.id]: 'builtin:letter' },
    defaultPaletteId: 'cream',
  });
  expect(app.store.chat(chat.id).settings).toEqual(chat.settings);
  expect(app.store.chat(chat.id).settingsRevision).toBe(chat.settingsRevision);
});

describe('Independent layout and palette choices', () => {
  function choose(
    store: Store,
    dimension: 'theme' | 'palette',
    id: string | null,
    scope: SelectThemeRequest['scope'] = 'global',
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

  test('default and named palettes supply complete, valid light and dark tokens', () => {
    for (const palette of [
      ...BUILTIN_PALETTES,
      { id: 'default', colors: DEFAULT_PALETTE_COLORS },
    ]) {
      for (const mode of ['light', 'dark'] as const)
        expect(Object.keys(palette.colors[mode]).sort()).toEqual([...THEME_COLOR_KEYS].sort());
      expect(validateTheme({ ...emptyTheme(), colors: palette.colors }).colors).toEqual(
        palette.colors
      );
    }
  });

  test('startup CSS matches the built-in default palette before React applies theme colors', () => {
    const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
    for (const mode of ['light', 'dark'] as const) {
      const selector = mode === 'light' ? ':root' : ':root[data-theme="dark"]';
      const body = css.slice(css.indexOf(`${selector} {`) + selector.length + 2).split('}')[0];
      const declarations = Object.fromEntries(
        [...body.matchAll(/--([a-z-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()])
      );
      for (const [key, value] of Object.entries(DEFAULT_PALETTE_COLORS[mode]))
        expect(declarations[key], `${mode} --${key}`).toBe(value);
    }
  });

  test('built-in palettes keep readable contrast on controls, selections and solid actions', () => {
    const luminance = (hex: string) => {
      const rgb = hex.match(/[0-9a-f]{2}/gi)!.map((value) => parseInt(value, 16) / 255);
      const [r, g, b] = rgb.map((value) =>
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      );
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const palette of [
      ...BUILTIN_PALETTES,
      { id: 'default', colors: DEFAULT_PALETTE_COLORS },
    ]) {
      for (const mode of ['light', 'dark'] as const) {
        const colors = palette.colors[mode];
        for (const [background, foreground] of [
          ['panel', 'text'],
          ['panel', 'muted'],
          ['panel', 'accent-text'],
          ['surface', 'text'],
          ['surface', 'muted'],
          ['hover', 'text'],
          ['hover', 'muted'],
          ['accent-soft', 'text'],
          ['accent-soft', 'accent-text'],
          ['accent', 'accent-ink'],
          ['accent-hover', 'accent-hover-ink'],
          ['error-solid', 'error-ink'],
          ['error-hover', 'error-ink'],
        ] as const) {
          const values = [luminance(colors[background]), luminance(colors[foreground])];
          expect(
            (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05),
            `${palette.id} ${mode} ${foreground}/${background}`
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
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
        selectTheme(
          store,
          parseInput(appearanceOperations.selectTheme.input, {
            scope: 'global',
            expectedRevision: 0,
            ...input,
          })
        )
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
});
