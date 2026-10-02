import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import { HttpError, fields, number, record, text } from './request-validation.js';
import {
  BUILTIN_ILLUSTRATION_PRESET,
  DEFAULT_ILLUSTRATION_PRESET_ID,
  defaultIllustrationPresetPreferences,
  illustrationPresetFile,
  illustrationPresetIds,
  validateIllustrationPreset,
  normalizeIllustrationPreset,
  type IllustrationPreset,
  type IllustrationPresetCatalog,
  type IllustrationPresetPreferences,
} from '../core/illustration-presets.js';

const preferenceKey = 'illustration-preset-preferences';
export function illustrationPresetPreferences(store: Store): IllustrationPresetPreferences {
  const row = store.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(preferenceKey);
  return row ? JSON.parse(String(row.value)) : defaultIllustrationPresetPreferences();
}
function writePreferences(store: Store, p: IllustrationPresetPreferences) {
  const next = { ...p, revision: p.revision + 1 };
  store.db
    .prepare(
      'INSERT INTO app_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    )
    .run(preferenceKey, JSON.stringify(next));
  return next;
}
export function readIllustrationPreset(store: Store, id: string): IllustrationPreset {
  return id === DEFAULT_ILLUSTRATION_PRESET_ID
    ? BUILTIN_ILLUSTRATION_PRESET
    : normalizeIllustrationPreset(store.product.get<IllustrationPreset>('illustration-preset', id));
}
export function illustrationPresetCatalog(store: Store): IllustrationPresetCatalog {
  return {
    presets: [
      BUILTIN_ILLUSTRATION_PRESET,
      ...store.product.all('illustration-preset').map(normalizeIllustrationPreset),
    ],
    preferences: illustrationPresetPreferences(store),
  };
}
/** Fetch only the selected recipe, not every potentially large workflow in the catalogue. */
export function effectiveIllustrationPreset(store: Store, chatId: string): IllustrationPreset {
  const chat = store.chat(chatId);
  for (const id of illustrationPresetIds(illustrationPresetPreferences(store), {
    chatId,
    botId: chat.botId,
  })) {
    try {
      return readIllustrationPreset(store, id);
    } catch (error) {
      if (!(error instanceof HttpError) || error.statusCode !== 404) throw error;
    }
  }
  return BUILTIN_ILLUSTRATION_PRESET;
}
export function saveIllustrationPreset(
  store: Store,
  value: unknown,
  id?: string,
  expectedRevision?: number
): IllustrationPreset {
  if (id?.startsWith('builtin:')) throw new HttpError(400, '기본 프리셋은 복제해서 수정해 주세요.');
  let model: ReturnType<typeof validateIllustrationPreset>;
  try {
    model = validateIllustrationPreset(value);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  return store.product.save(
    'illustration-preset',
    model,
    id,
    expectedRevision
  ) as IllustrationPreset;
}
export function selectIllustrationPreset(store: Store, value: unknown) {
  const b = record(value);
  fields(b, ['scope', 'targetId', 'presetId', 'expectedRevision']);
  const scope = text(b.scope, 'scope', 10);
  if (!['global', 'bot', 'chat'].includes(scope))
    throw new HttpError(400, '삽화 프리셋 적용 범위를 확인해 주세요.');
  const presetId = b.presetId === null ? null : text(b.presetId, 'preset ID', 100);
  const targetId = scope === 'global' ? '' : text(b.targetId, 'target ID', 100);
  const expected = number(b.expectedRevision, 'revision', 0);
  return store.transaction(() => {
    if (presetId) readIllustrationPreset(store, presetId);
    if (scope === 'bot') store.organization.bot(targetId);
    if (scope === 'chat') store.chat(targetId);
    const p = illustrationPresetPreferences(store);
    if (p.revision !== expected)
      throw new HttpError(
        409,
        '다른 창에서 삽화 프리셋 선택을 바꿨어요. 다시 불러온 뒤 선택해 주세요.'
      );
    if (scope === 'global') p.defaultPresetId = presetId ?? DEFAULT_ILLUSTRATION_PRESET_ID;
    else {
      const map = scope === 'bot' ? p.botPresets : p.chatPresets;
      if (presetId) map[targetId] = presetId;
      else delete map[targetId];
    }
    return writePreferences(store, p);
  });
}
export function deleteIllustrationPreset(store: Store, id: string, expectedRevision: number) {
  if (id.startsWith('builtin:')) throw new HttpError(400, '기본 프리셋은 삭제할 수 없어요.');
  return store.transaction(() => {
    const preset = readIllustrationPreset(store, id);
    if (preset.revision !== expectedRevision)
      throw new HttpError(409, '삽화 프리셋이 변경됐어요. 최신 저장본을 확인해 주세요.');
    const p = illustrationPresetPreferences(store);
    if (p.defaultPresetId === id) p.defaultPresetId = DEFAULT_ILLUSTRATION_PRESET_ID;
    for (const map of [p.botPresets, p.chatPresets])
      for (const [key, selected] of Object.entries(map)) if (selected === id) delete map[key];
    writePreferences(store, p);
    store.db.prepare('DELETE FROM versions WHERE kind=? AND id=?').run('illustration-preset', id);
    store.db
      .prepare('DELETE FROM resource_undo WHERE kind=? AND id=?')
      .run('illustration-preset', id);
    return { deleted: id };
  });
}
export function removeIllustrationPresetScope(store: Store, scope: 'bot' | 'chat', id: string) {
  const p = illustrationPresetPreferences(store);
  const map = scope === 'bot' ? p.botPresets : p.chatPresets;
  if (Object.hasOwn(map, id)) {
    delete map[id];
    writePreferences(store, p);
  }
}
export function illustrationPresetRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/illustration-presets', (_request, reply) =>
    reply.header('Cache-Control', 'no-store').send(illustrationPresetCatalog(store))
  );
  app.post('/api/illustration-presets/selection', (request) =>
    selectIllustrationPreset(store, request.body)
  );
  app.get<{ Params: { id: string } }>('/api/illustration-presets/:id/export', (request) =>
    illustrationPresetFile(readIllustrationPreset(store, request.params.id))
  );
  app.delete<{ Params: { id: string } }>('/api/illustration-presets/:id', (request) => {
    const b = record(request.body);
    fields(b, ['expectedRevision']);
    return deleteIllustrationPreset(
      store,
      request.params.id,
      number(b.expectedRevision, 'revision')
    );
  });
}
