import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import { HttpError, choice, fields, number, record, text } from './request-validation.js';
import { AppError, HelperToolError, validationAppError } from './app-errors.js';
import { ValidationError } from '../core/validation-error.js';
import { assertAppearanceTargetLive } from './appearance-scope.js';
import { forgetHelperConfirmationTargets } from './helper-argument-retention.js';
import {
  BUILTIN_ILLUSTRATION_PRESET,
  DEFAULT_ILLUSTRATION_PRESET_ID,
  defaultIllustrationPresetPreferences,
  illustrationPresetFile,
  illustrationPresetIds,
  validateIllustrationPreset,
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
  store.invalidated('illustration-presets');
  return next;
}
export function readIllustrationPreset(store: Store, id: string): IllustrationPreset {
  return id === DEFAULT_ILLUSTRATION_PRESET_ID
    ? BUILTIN_ILLUSTRATION_PRESET
    : store.product.available<IllustrationPreset>('illustration-preset', id);
}
export function illustrationPresetCatalog(store: Store): IllustrationPresetCatalog {
  return {
    presets: [
      BUILTIN_ILLUSTRATION_PRESET,
      ...(store.product.all('illustration-preset') as IllustrationPreset[]),
    ],
    preferences: illustrationPresetPreferences(store),
  };
}
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
  if (id?.startsWith('builtin:'))
    throw new HelperToolError(
      400,
      'ILLUSTRATION_PRESET_BUILTIN_READONLY',
      'Save a copy under a new ID.'
    );
  let model: ReturnType<typeof validateIllustrationPreset>;
  try {
    model = validateIllustrationPreset(value);
  } catch (error) {
    if (error instanceof ValidationError) throw validationAppError(error);
    throw new HelperToolError(400, 'ILLUSTRATION_PRESET_INVALID', (error as Error).message);
  }
  const saved = store.product.save(
    'illustration-preset',
    model,
    id,
    expectedRevision
  ) as IllustrationPreset;
  store.invalidated('illustration-presets');
  return saved;
}
export function selectIllustrationPreset(store: Store, value: unknown) {
  const b = record(value);
  fields(b, ['scope', 'targetId', 'presetId', 'expectedRevision']);
  const scope = choice(b.scope, ['global', 'bot', 'chat'], 'scope');
  const presetId = b.presetId === null ? null : text(b.presetId, 'preset ID', 100);
  const targetId = scope === 'global' ? '' : text(b.targetId, 'target ID', 100);
  const expected = number(b.expectedRevision, 'revision', 0);
  return store.transaction(() => {
    const p = illustrationPresetPreferences(store);
    if (p.revision !== expected) throw new AppError(409, 'REVISION_CONFLICT');
    if (presetId) readIllustrationPreset(store, presetId);
    assertAppearanceTargetLive(store, scope, targetId);
    if (scope === 'bot') store.organization.bot(targetId);
    if (scope === 'chat') store.chat(targetId);
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
  if (id.startsWith('builtin:'))
    throw new HelperToolError(
      400,
      'ILLUSTRATION_PRESET_BUILTIN_READONLY',
      'Built-in presets stay.'
    );
  return store.transaction(() => {
    store.product.editable('illustration-preset', id, expectedRevision);
    const p = illustrationPresetPreferences(store);
    if (p.defaultPresetId === id) p.defaultPresetId = DEFAULT_ILLUSTRATION_PRESET_ID;
    for (const map of [p.botPresets, p.chatPresets])
      for (const [key, selected] of Object.entries(map)) if (selected === id) delete map[key];
    writePreferences(store, p);
    store.db.prepare('DELETE FROM versions WHERE kind=? AND id=?').run('illustration-preset', id);
    store.db
      .prepare('DELETE FROM resource_undo WHERE kind=? AND id=?')
      .run('illustration-preset', id);
    forgetHelperConfirmationTargets(store.db, [{ kind: 'illustration-preset', id }]);
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
