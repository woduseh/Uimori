import { validatePalette } from '../core/palette-files.js';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { isStoryUiThemeSetting } from '../core/story-ui-style.js';
import type { RunSnapshot } from '../core/types.js';
import type { Store } from './store.js';
import {
  appearanceEndpoints as endpoints,
  type SelectThemeBackground,
  type SelectThemeRequest,
} from '#contracts';
import { appearanceOperations as operations } from '#contracts/operations';
import { HttpError } from './request-validation.js';
import { AppError, asAppError, assertRevision, HelperToolError } from './app-errors.js';
import { NOT_MODIFIED, registerEndpoint } from './endpoint.js';
import { matchesEntityTag } from './private-etag.js';
import { forgetHelperResourceChanges } from './helper-changes.js';
import { forgetHelperConfirmationTargets } from './helper-argument-retention.js';
import {
  BUILTIN_THEMES,
  getBuiltinTheme,
  normalizeThemePreferences,
  DEFAULT_THEME_ID,
  defaultThemePreferences,
  validateTheme,
  type Theme,
  type ThemeCatalog,
  type ThemePreferences,
} from '../core/themes.js';

import {
  BUILTIN_PALETTES,
  THEME_PALETTE_ID,
  isPaletteId,
  type Palette,
} from '../core/theme-palettes.js';

import { defaultThemeBackground } from '../core/theme-background.js';
import { assertThemeAssetsStored, pruneThemeAssets, themeAssetHashes } from './theme-assets.js';
const preferenceKey = 'theme-preferences';
export function readTheme(store: Store, id: string): Theme {
  return getBuiltinTheme(id) ?? store.product.get<Theme>('theme', id);
}
export function themePreferences(store: Store): ThemePreferences {
  const row = store.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(preferenceKey);
  return row ? normalizeThemePreferences(JSON.parse(String(row.value))) : defaultThemePreferences();
}
export function themeCatalog(
  store: Store
): ThemeCatalog & { palettes: NonNullable<ThemeCatalog['palettes']> } {
  return {
    themes: [...BUILTIN_THEMES, ...store.product.all('theme')],
    palettes: paletteCatalog(store),
    preferences: themePreferences(store),
  };
}
export function storyUiThemeChoices(
  store: Store,
  botId: string
): RunSnapshot['storyUiThemeChoices'] {
  const { themes, preferences } = themeCatalog(store);
  const choices = themes.flatMap(({ id, title, description, storyUi }) => {
    const reference = `theme:${id}`;
    return storyUi && isStoryUiThemeSetting(reference)
      ? [{ id: reference, title, description, baseStyle: storyUi.baseStyle }]
      : [];
  });
  if (!choices.length) return;
  const botSelection = preferences.botStoryUiThemes?.[botId];
  const botThemeId = botSelection
    ? choices.find(({ id }) => id === `theme:${botSelection}`)?.id
    : undefined;
  return { themes: choices, ...(botThemeId && { botThemeId }) };
}
export function saveTheme(
  store: Store,
  value: unknown,
  id?: string,
  expectedRevision?: number
): Theme {
  if (id?.startsWith('builtin:'))
    throw new HelperToolError(400, 'THEME_BUILTIN_READONLY', 'Save a copy under a new ID.');
  let model: ReturnType<typeof validateTheme>;
  try {
    model = validateTheme(value);
  } catch (error) {
    throw asAppError(error);
  }
  assertThemeAssetsStored(store.db, model.assets);
  const saved = store.product.save('theme', model, id, expectedRevision) as Theme;
  store.invalidated('themes');
  return saved;
}
function writePreferences(store: Store, p: ThemePreferences): ThemePreferences {
  const next = { ...p, revision: p.revision + 1 };
  store.db
    .prepare(
      'INSERT INTO app_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    )
    .run(preferenceKey, JSON.stringify(next));
  store.invalidated('themes');
  return next;
}
function assertSelectionTarget(store: Store, scope: SelectThemeRequest['scope'], targetId: string) {
  if (scope === 'bot') {
    const content = store.product.get<{ kind: string }>('content', targetId);
    if (content.kind !== 'bot') throw new HttpError(400, 'Invalid target ID: expected a bot');
  }
  if (scope === 'chat') store.chat(targetId);
}
export function selectTheme(store: Store, input: SelectThemeRequest): ThemePreferences {
  const { scope, expectedRevision } = input;
  const dimension = input.dimension ?? 'theme';
  const selectedId = (dimension === 'palette' ? input.paletteId : input.themeId) ?? null;
  const targetId = input.targetId ?? '';
  return store.transaction(() => {
    const p = themePreferences(store);
    assertRevision(p.revision, expectedRevision);
    assertSelectionTarget(store, scope, targetId);
    if (selectedId !== null) {
      if (dimension === 'theme') readTheme(store, selectedId);
      else if (dimension === 'palette' && !isPaletteId(selectedId)) readPalette(store, selectedId);
    }
    if (dimension === 'storyUi') {
      if (selectedId !== null && !readTheme(store, selectedId).storyUi)
        throw new AppError(400, 'THEME_STORY_UI_MISSING');
      const map = (p.botStoryUiThemes ??= {});
      if (selectedId !== null) map[targetId] = selectedId;
      else delete map[targetId];
    } else if (dimension === 'palette') {
      if (scope === 'global') p.defaultPaletteId = selectedId ?? THEME_PALETTE_ID;
      else {
        const map = scope === 'bot' ? (p.botPalettes ??= {}) : (p.chatPalettes ??= {});
        if (selectedId !== null) map[targetId] = selectedId;
        else delete map[targetId];
      }
    } else if (scope === 'global') p.defaultThemeId = selectedId ?? DEFAULT_THEME_ID;
    else {
      const map = scope === 'bot' ? p.botThemes : p.chatThemes;
      if (selectedId) map[targetId] = selectedId;
      else delete map[targetId];
    }
    return writePreferences(store, p);
  });
}
export function selectThemeBackground(
  store: Store,
  { scope, targetId = '', background, expectedRevision }: SelectThemeBackground
): ThemePreferences {
  return store.transaction(() => {
    const p = themePreferences(store);
    assertRevision(p.revision, expectedRevision);
    assertSelectionTarget(store, scope, targetId);
    if (
      background?.imageHash &&
      !store.db.prepare('SELECT 1 FROM image_blobs WHERE hash=?').get(background.imageHash)
    )
      throw new AppError(400, 'IMAGE_NOT_FOUND');
    if (scope === 'global') p.defaultBackground = background ?? { ...defaultThemeBackground };
    else {
      const map = scope === 'bot' ? (p.botBackgrounds ??= {}) : (p.chatBackgrounds ??= {});
      if (background) map[targetId] = background;
      else delete map[targetId];
    }
    return writePreferences(store, p);
  });
}
function assertStoredRevision(
  store: Store,
  kind: 'theme' | 'palette',
  id: string,
  expected: number
) {
  const row = store.db.prepare('SELECT revision FROM versions WHERE kind=? AND id=?').get(kind, id);
  if (!row) throw new AppError(409, 'REVISION_CONFLICT');
  assertRevision(Number(row.revision), expected);
}
export function deleteTheme(store: Store, id: string, expectedRevision: number) {
  if (id.startsWith('builtin:')) throw new HelperToolError(400, 'THEME_BUILTIN_READONLY');
  return store.transaction(() => {
    assertStoredRevision(store, 'theme', id, expectedRevision);
    const theme = readTheme(store, id);
    const undo = store.db
      .prepare("SELECT model FROM resource_undo WHERE kind='theme' AND id=?")
      .get(id)?.model;
    const owned = [
      ...themeAssetHashes(theme),
      ...(typeof undo === 'string' ? themeAssetHashes(JSON.parse(undo)) : []),
    ];
    const p = themePreferences(store);
    if (p.defaultThemeId === id) p.defaultThemeId = DEFAULT_THEME_ID;
    for (const map of [p.botThemes, p.chatThemes, p.botStoryUiThemes]) {
      if (!map) continue;
      for (const [key, value] of Object.entries(map)) if (value === id) delete map[key];
    }
    writePreferences(store, p);
    store.db.prepare('DELETE FROM versions WHERE kind=? AND id=?').run('theme', id);
    store.db.prepare('DELETE FROM resource_undo WHERE kind=? AND id=?').run('theme', id);
    forgetHelperResourceChanges(store.db, 'theme', id);
    forgetHelperConfirmationTargets(store.db, [{ kind: 'theme', id }]);
    pruneThemeAssets(store.db, owned);
    return { deleted: id };
  });
}

export function paletteCatalog(store: Store) {
  return [...BUILTIN_PALETTES, ...(store.product.all('palette') as Palette[])];
}
export function readPalette(store: Store, id: string) {
  return (
    BUILTIN_PALETTES.find((palette) => palette.id === id) ??
    store.product.get<Palette>('palette', id)
  );
}
export function savePalette(
  store: Store,
  value: unknown,
  id?: string,
  expectedRevision?: number
): Palette {
  if (id && isPaletteId(id))
    throw new HelperToolError(400, 'PALETTE_BUILTIN_READONLY', 'Save a copy without an ID.');
  let model: ReturnType<typeof validatePalette>;
  try {
    model = validatePalette(value);
  } catch (error) {
    throw asAppError(error);
  }
  const saved = store.transaction(() => {
    if (id !== undefined) assertStoredRevision(store, 'palette', id, expectedRevision ?? 0);
    return store.product.save('palette', model, id, expectedRevision) as Palette;
  });
  store.invalidated('themes');
  return saved;
}
export function deletePalette(store: Store, id: string, expectedRevision: number) {
  if (isPaletteId(id)) throw new HelperToolError(400, 'PALETTE_BUILTIN_READONLY');
  return store.transaction(() => {
    assertStoredRevision(store, 'palette', id, expectedRevision);
    const p = themePreferences(store);
    if (p.defaultPaletteId === id) p.defaultPaletteId = THEME_PALETTE_ID;
    for (const map of [p.botPalettes, p.chatPalettes])
      for (const [key, value] of Object.entries(map ?? {})) if (value === id) delete map![key];
    writePreferences(store, p);
    store.db.prepare('DELETE FROM versions WHERE kind=? AND id=?').run('palette', id);
    store.db.prepare('DELETE FROM resource_undo WHERE kind=? AND id=?').run('palette', id);
    return { deleted: id };
  });
}

function themeCatalogTag(store: Store, builtinVersion: string) {
  const versions = (kind: string) =>
    store.db.prepare('SELECT id,revision FROM versions WHERE kind=? ORDER BY id').all(kind);
  const version = createHash('sha256')
    .update(
      JSON.stringify([
        builtinVersion,
        versions('theme'),
        versions('palette'),
        themePreferences(store).revision,
      ])
    )
    .digest('hex');
  return `"${version}"`;
}

export function themeRoutes(app: FastifyInstance, store: Store) {
  const builtinVersion = createHash('sha256')
    .update(JSON.stringify([BUILTIN_THEMES, BUILTIN_PALETTES]))
    .digest('hex');
  registerEndpoint(app, endpoints.readThemes, operations.readThemes, (_input, request, reply) => {
    const etag = themeCatalogTag(store, builtinVersion);
    reply.header('ETag', etag).header('Cache-Control', 'private, no-cache');
    if (matchesEntityTag(request.headers['if-none-match'], etag)) return NOT_MODIFIED;
    return themeCatalog(store);
  });
  registerEndpoint(app, endpoints.selectTheme, operations.selectTheme, (input) =>
    selectTheme(store, input)
  );
  registerEndpoint(
    app,
    endpoints.selectThemeBackground,
    operations.selectThemeBackground,
    (input) => selectThemeBackground(store, input)
  );
  registerEndpoint(app, endpoints.deleteTheme, operations.deleteTheme, ({ id, expectedRevision }) =>
    deleteTheme(store, id, expectedRevision)
  );
  registerEndpoint(app, endpoints.listPalettes, operations.listPalettes, () => ({
    palettes: paletteCatalog(store),
  }));
  registerEndpoint(app, endpoints.createPalette, operations.createPalette, ({ model }) =>
    savePalette(store, model)
  );
  registerEndpoint(
    app,
    endpoints.updatePalette,
    operations.updatePalette,
    ({ id, model, expectedRevision }) => savePalette(store, model, id, expectedRevision)
  );
  registerEndpoint(
    app,
    endpoints.deletePalette,
    operations.deletePalette,
    ({ id, expectedRevision }) => deletePalette(store, id, expectedRevision)
  );
}
