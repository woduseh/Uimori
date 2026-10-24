import { validatePalette, paletteFile } from '../core/palette-files.js';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import { HttpError, fields, number, record, text } from './request-validation.js';
import {
  BUILTIN_THEMES,
  LEGACY_BUILTIN_THEMES,
  getBuiltinTheme,
  normalizeThemePreferences,
  DEFAULT_THEME_ID,
  defaultThemePreferences,
  validateTheme,
  themeFile,
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

import { defaultThemeBackground, validateThemeBackground } from '../core/theme-background.js';
const preferenceKey = 'theme-preferences';
export function readTheme(store: Store, id: string): Theme {
  return getBuiltinTheme(id) ?? store.product.get<Theme>('theme', id);
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
export function saveTheme(
  store: Store,
  value: unknown,
  id?: string,
  expectedRevision?: number
): Theme {
  if (id?.startsWith('builtin:')) throw new HttpError(400, '기본 테마는 복제해서 수정해 주세요.');
  let model: ReturnType<typeof validateTheme>;
  try {
    model = validateTheme(value);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  return store.product.save('theme', model, id, expectedRevision) as Theme;
}
function writePreferences(store: Store, p: ThemePreferences): ThemePreferences {
  const next = { ...p, revision: p.revision + 1 };
  store.db
    .prepare(
      'INSERT INTO app_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    )
    .run(preferenceKey, JSON.stringify(next));
  return next;
}
export function selectTheme(store: Store, input: unknown): ThemePreferences {
  const b = record(input);
  fields(b, ['scope', 'targetId', 'dimension', 'themeId', 'paletteId', 'expectedRevision']);
  const dimension = b.dimension === undefined ? 'theme' : text(b.dimension, 'dimension', 10);
  if (dimension !== 'theme' && dimension !== 'palette')
    throw new HttpError(400, '테마 또는 팔레트 선택을 확인해 주세요.');
  if (dimension === 'theme' ? 'paletteId' in b : 'themeId' in b)
    throw new HttpError(400, '테마와 팔레트는 각각 선택해 주세요.');
  const scope = text(b.scope, 'scope', 10);
  if (!['global', 'bot', 'chat'].includes(scope))
    throw new HttpError(400, '테마 적용 범위를 확인해 주세요.');
  const rawId = dimension === 'theme' ? b.themeId : b.paletteId;
  const selectedId = rawId === null ? null : text(rawId, dimension + ' ID', 100);
  if (selectedId !== null) {
    if (dimension === 'theme') readTheme(store, selectedId);
    else if (
      !isPaletteId(selectedId) &&
      !paletteCatalog(store).some((palette) => palette.id === selectedId)
    )
      throw new HttpError(400, '지원하지 않는 팔레트예요.');
  }
  // Old clients may still submit a retired palette-only preset. Keep layout and palette
  // dimensions independent: the layout alias must not overwrite an existing palette choice.
  const themeId =
    selectedId === 'builtin:midnight' || selectedId === 'builtin:blossom'
      ? DEFAULT_THEME_ID
      : selectedId === 'builtin:liquid-gallery'
        ? 'builtin:cinematic'
        : selectedId;
  const targetId = scope === 'global' ? '' : text(b.targetId, 'target ID', 100);
  if (scope === 'bot') {
    const content = store.product.get<{ kind: string }>('content', targetId);
    if (content.kind !== 'bot') throw new HttpError(400, '봇에만 기본 테마를 지정할 수 있어요.');
  }
  if (scope === 'chat') store.chat(targetId);
  const expected = number(b.expectedRevision, 'revision', 0);
  return store.transaction(() => {
    const p = themePreferences(store);
    if (p.revision !== expected)
      throw new HttpError(409, '다른 창에서 테마 선택을 바꿨어요. 다시 불러온 뒤 선택해 주세요.');
    if (dimension === 'palette') {
      if (scope === 'global') p.defaultPaletteId = selectedId ?? THEME_PALETTE_ID;
      else {
        const map = scope === 'bot' ? (p.botPalettes ??= {}) : (p.chatPalettes ??= {});
        if (selectedId !== null) map[targetId] = selectedId;
        else delete map[targetId];
      }
    } else if (scope === 'global') p.defaultThemeId = themeId ?? DEFAULT_THEME_ID;
    else {
      const map = scope === 'bot' ? p.botThemes : p.chatThemes;
      if (themeId) map[targetId] = themeId;
      else delete map[targetId];
    }
    return writePreferences(store, p);
  });
}
export function selectThemeBackground(store: Store, input: unknown): ThemePreferences {
  const b = record(input);
  fields(b, ['scope', 'targetId', 'background', 'expectedRevision']);
  const scope = text(b.scope, 'scope', 10);
  if (!['global', 'bot', 'chat'].includes(scope))
    throw new HttpError(400, '배경 적용 범위를 확인해 주세요.');
  const targetId = scope === 'global' ? '' : text(b.targetId, 'target ID', 100);
  if (scope === 'bot') {
    const content = store.product.get<{ kind: string }>('content', targetId);
    if (content.kind !== 'bot') throw new HttpError(400, '봇에만 기본 배경을 지정할 수 있어요.');
  }
  if (scope === 'chat') store.chat(targetId);
  let background: ReturnType<typeof validateThemeBackground> | null;
  try {
    background = b.background === null ? null : validateThemeBackground(b.background);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  const expected = number(b.expectedRevision, 'revision', 0);
  return store.transaction(() => {
    const p = themePreferences(store);
    if (p.revision !== expected)
      throw new HttpError(409, '다른 창에서 테마 설정을 바꿨어요. 다시 불러온 뒤 저장해 주세요.');
    if (
      background?.imageHash &&
      !store.db.prepare('SELECT 1 FROM image_blobs WHERE hash=?').get(background.imageHash)
    )
      throw new HttpError(400, '배경 이미지를 먼저 업로드해 주세요.');
    if (scope === 'global') p.defaultBackground = background ?? { ...defaultThemeBackground };
    else {
      const map = scope === 'bot' ? (p.botBackgrounds ??= {}) : (p.chatBackgrounds ??= {});
      if (background) map[targetId] = background;
      else delete map[targetId];
    }
    return writePreferences(store, p);
  });
}
export function deleteTheme(store: Store, id: string, expectedRevision: number) {
  if (id.startsWith('builtin:')) throw new HttpError(400, '기본 테마는 삭제할 수 없어요.');
  return store.transaction(() => {
    const theme = readTheme(store, id);
    if (theme.revision !== expectedRevision)
      throw new HttpError(409, '테마가 변경됐어요. 최신 저장본을 확인해 주세요.');
    const p = themePreferences(store);
    if (p.defaultThemeId === id) p.defaultThemeId = DEFAULT_THEME_ID;
    for (const map of [p.botThemes, p.chatThemes])
      for (const [key, value] of Object.entries(map)) if (value === id) delete map[key];
    writePreferences(store, p);
    store.db.prepare('DELETE FROM versions WHERE kind=? AND id=?').run('theme', id);
    store.db.prepare('DELETE FROM resource_undo WHERE kind=? AND id=?').run('theme', id);
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
  if (id && isPaletteId(id)) throw new HttpError(400, '기본 팔레트는 복제해서 수정해 주세요.');
  let model: ReturnType<typeof validatePalette>;
  try {
    model = validatePalette(value);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  return store.product.save('palette', model, id, expectedRevision) as Palette;
}
export function deletePalette(store: Store, id: string, expectedRevision: number) {
  if (isPaletteId(id)) throw new HttpError(400, '기본 팔레트는 삭제할 수 없어요.');
  return store.transaction(() => {
    const palette = readPalette(store, id) as Palette;
    if (palette.revision !== expectedRevision)
      throw new HttpError(409, '팔레트가 변경됐어요. 최신 저장본을 확인해 주세요.');
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

export function themeRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/palettes', () => ({ palettes: paletteCatalog(store) }));
  app.post('/api/palettes', (request) => {
    const b = record(request.body);
    fields(b, ['model']);
    return savePalette(store, b.model);
  });
  app.put<{ Params: { id: string } }>('/api/palettes/:id', (request) => {
    const b = record(request.body);
    fields(b, ['model', 'expectedRevision']);
    return savePalette(
      store,
      b.model,
      request.params.id,
      number(b.expectedRevision, 'revision', 1)
    );
  });
  app.get<{ Params: { id: string } }>('/api/palettes/:id/export', (request) =>
    paletteFile(readPalette(store, request.params.id))
  );
  app.delete<{ Params: { id: string } }>('/api/palettes/:id', (request) => {
    const b = record(request.body);
    fields(b, ['expectedRevision']);
    return deletePalette(store, request.params.id, number(b.expectedRevision, 'revision', 1));
  });
  const builtinVersion = createHash('sha256')
    .update(JSON.stringify([BUILTIN_THEMES, LEGACY_BUILTIN_THEMES, BUILTIN_PALETTES]))
    .digest('hex');
  app.get('/api/themes', (request, reply) => {
    const versions = store.db
      .prepare("SELECT id,revision FROM versions WHERE kind='theme' ORDER BY id")
      .all();
    const version = createHash('sha256')
      .update(
        JSON.stringify([
          builtinVersion,
          versions,
          store.db
            .prepare("SELECT id,revision FROM versions WHERE kind='palette' ORDER BY id")
            .all(),
          themePreferences(store).revision,
        ])
      )
      .digest('hex');
    const etag = `"${version}"`;
    reply.header('ETag', etag).header('Cache-Control', 'private, no-cache');
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    return themeCatalog(store);
  });
  app.post('/api/themes/selection', (request) => selectTheme(store, request.body));
  app.post('/api/themes/background', (request) => selectThemeBackground(store, request.body));
  app.get<{ Params: { id: string } }>('/api/themes/:id/export', (request) =>
    themeFile(readTheme(store, request.params.id))
  );
  app.delete<{ Params: { id: string } }>('/api/themes/:id', (request) => {
    const b = record(request.body);
    fields(b, ['expectedRevision']);
    return deleteTheme(store, request.params.id, number(b.expectedRevision, 'revision'));
  });
}
