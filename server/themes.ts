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
import { assertAppearanceTargetLive } from './appearance-scope.js';
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
  return getBuiltinTheme(id) ?? store.product.available<Theme>('theme', id);
}
export function themePreferences(store: Store): ThemePreferences {
  const row = store.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(preferenceKey);
  return row ? normalizeThemePreferences(JSON.parse(String(row.value))) : defaultThemePreferences();
}
export function themeCatalog(store: Store): ThemeCatalog {
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
export function removeThemeScope(store: Store, scope: 'bot' | 'chat', id: string) {
  const p = themePreferences(store);
  const maps =
    scope === 'bot'
      ? [p.botThemes, p.botPalettes, p.botStoryUiThemes, p.botBackgrounds]
      : [p.chatThemes, p.chatPalettes, p.chatBackgrounds];
  let changed = false;
  for (const map of maps)
    if (map && Object.hasOwn(map, id)) {
      delete map[id];
      changed = true;
    }
  if (changed) writePreferences(store, p);
}
function assertSelectionTarget(store: Store, input: SelectThemeRequest | SelectThemeBackground) {
  if (input.scope === 'global') return;
  assertAppearanceTargetLive(store, input.scope, input.targetId);
  if (
    input.scope === 'bot' &&
    store.product.stored<{ kind: string }>('content', input.targetId).kind !== 'bot'
  )
    throw new HttpError(400, 'Invalid target ID: expected a bot');
}
function scopedMap(
  p: ThemePreferences,
  scope: 'bot' | 'chat',
  dimension: 'theme' | 'palette'
): Record<string, string> {
  if (dimension === 'theme') return scope === 'bot' ? p.botThemes : p.chatThemes;
  return scope === 'bot' ? (p.botPalettes ??= {}) : (p.chatPalettes ??= {});
}
function setChoice<T>(map: Record<string, T>, targetId: string, value: T | null) {
  if (value === null) delete map[targetId];
  else map[targetId] = value;
}
export function selectTheme(store: Store, input: SelectThemeRequest): ThemePreferences {
  return store.transaction(() => {
    const p = themePreferences(store);
    assertRevision(p.revision, input.expectedRevision);
    assertSelectionTarget(store, input);
    if (input.dimension === 'palette') {
      const { paletteId } = input;
      if (paletteId !== null && !isPaletteId(paletteId)) readPalette(store, paletteId);
      if (input.scope === 'global') p.defaultPaletteId = paletteId ?? THEME_PALETTE_ID;
      else setChoice(scopedMap(p, input.scope, 'palette'), input.targetId, paletteId);
      return writePreferences(store, p);
    }
    const theme = input.themeId === null ? null : readTheme(store, input.themeId);
    if (input.dimension === 'storyUi') {
      if (theme && !theme.storyUi) throw new AppError(400, 'THEME_STORY_UI_MISSING');
      setChoice((p.botStoryUiThemes ??= {}), input.targetId, input.themeId);
    } else if (input.scope === 'global') p.defaultThemeId = input.themeId ?? DEFAULT_THEME_ID;
    else setChoice(scopedMap(p, input.scope, 'theme'), input.targetId, input.themeId);
    return writePreferences(store, p);
  });
}
export function selectThemeBackground(
  store: Store,
  input: SelectThemeBackground
): ThemePreferences {
  const { background } = input;
  return store.transaction(() => {
    const p = themePreferences(store);
    assertRevision(p.revision, input.expectedRevision);
    assertSelectionTarget(store, input);
    if (
      background?.imageHash &&
      !store.db.prepare('SELECT 1 FROM image_blobs WHERE hash=?').get(background.imageHash)
    )
      throw new AppError(400, 'IMAGE_NOT_FOUND');
    if (input.scope === 'global') p.defaultBackground = background ?? { ...defaultThemeBackground };
    else
      setChoice(
        input.scope === 'bot' ? (p.botBackgrounds ??= {}) : (p.chatBackgrounds ??= {}),
        input.targetId,
        background
      );
    return writePreferences(store, p);
  });
}
export function deleteTheme(store: Store, id: string, expectedRevision: number) {
  if (id.startsWith('builtin:')) throw new HelperToolError(400, 'THEME_BUILTIN_READONLY');
  return store.transaction(() => {
    const theme = store.product.editable<Theme>('theme', id, expectedRevision);
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
    store.product.available<Palette>('palette', id)
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
  const saved = store.transaction(() => {
    if (id) store.product.editable('palette', id, expectedRevision);
    let model: ReturnType<typeof validatePalette>;
    try {
      model = validatePalette(value);
    } catch (error) {
      throw asAppError(error);
    }
    return store.product.saveInTransaction('palette', model, id, expectedRevision) as Palette;
  });
  store.invalidated('themes');
  return saved;
}
export function deletePalette(store: Store, id: string, expectedRevision: number) {
  if (isPaletteId(id)) throw new HelperToolError(400, 'PALETTE_BUILTIN_READONLY');
  return store.transaction(() => {
    store.product.editable('palette', id, expectedRevision);
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
