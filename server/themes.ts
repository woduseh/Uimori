import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import { HttpError, fields, number, record, text } from './request-validation.js';
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  defaultThemePreferences,
  validateTheme,
  themeFile,
  type Theme,
  type ThemeCatalog,
  type ThemePreferences,
} from '../core/themes.js';

const preferenceKey = 'theme-preferences';
export function readTheme(store: Store, id: string): Theme {
  return BUILTIN_THEMES.find((theme) => theme.id === id) ?? store.product.get<Theme>('theme', id);
}
export function themePreferences(store: Store): ThemePreferences {
  const row = store.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(preferenceKey);
  return row ? JSON.parse(String(row.value)) : defaultThemePreferences();
}
export function themeCatalog(store: Store): ThemeCatalog {
  return {
    themes: [...BUILTIN_THEMES, ...store.product.all('theme')],
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
  fields(b, ['scope', 'targetId', 'themeId', 'expectedRevision']);
  const scope = text(b.scope, 'scope', 10);
  if (!['global', 'bot', 'chat'].includes(scope))
    throw new HttpError(400, '테마 적용 범위를 확인해 주세요.');
  const themeId = b.themeId === null ? null : text(b.themeId, 'theme ID', 100);
  if (themeId) readTheme(store, themeId);
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
    if (scope === 'global') p.defaultThemeId = themeId ?? DEFAULT_THEME_ID;
    else {
      const map = scope === 'bot' ? p.botThemes : p.chatThemes;
      if (themeId) map[targetId] = themeId;
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
export function themeRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/themes', () => themeCatalog(store));
  app.post('/api/themes/selection', (request) => selectTheme(store, request.body));
  app.get<{ Params: { id: string } }>('/api/themes/:id/export', (request) =>
    themeFile(readTheme(store, request.params.id))
  );
  app.delete<{ Params: { id: string } }>('/api/themes/:id', (request) => {
    const b = record(request.body);
    fields(b, ['expectedRevision']);
    return deleteTheme(store, request.params.id, number(b.expectedRevision, 'revision'));
  });
}
