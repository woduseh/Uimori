import type { FastifyInstance } from 'fastify';
import type { AutoTranslationDefaults } from '../core/chat-settings.js';
import type { DatabaseSync } from 'node:sqlite';
import type { Store } from './store.js';
import { fields, HttpError, number, record } from './request-validation.js';
import { AppError } from './app-errors.js';
import { isWrittenLanguage } from '../core/written-language.js';

const KEY = 'auto-translation-defaults';

export function autoTranslationDefaults(db: DatabaseSync): AutoTranslationDefaults {
  const row = db.prepare('SELECT value FROM app_metadata WHERE key=?').get(KEY);
  const stored = row ? (JSON.parse(String(row.value)) as Partial<AutoTranslationDefaults>) : {};
  return {
    revision: stored.revision ?? 0,
    autoTranslate: stored.autoTranslate ?? false,
    translationLanguage:
      stored.translationLanguage === undefined ? 'ko' : stored.translationLanguage,
  };
}

export function autoTranslationDefaultRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/auto-translation-defaults', () => autoTranslationDefaults(store.db));
  app.put('/api/auto-translation-defaults', (request) =>
    saveAutoTranslationDefaults(store, request.body)
  );
}
export function saveAutoTranslationDefaults(store: Store, value: unknown): AutoTranslationDefaults {
  const body = record(value);
  fields(body, ['expectedRevision', 'autoTranslate', 'translationLanguage']);
  const expected = number(body.expectedRevision, 'revision', 0);
  if (typeof body.autoTranslate !== 'boolean') throw new HttpError(400, 'Invalid autoTranslate');
  const language = body.translationLanguage;
  if (language !== undefined && language !== null && !isWrittenLanguage(language))
    throw new HttpError(400, 'Invalid translation language');
  return store.transaction(() => {
    const previous = autoTranslationDefaults(store.db);
    if (previous.revision !== expected) throw new AppError(409, 'REVISION_CONFLICT');
    const next: AutoTranslationDefaults = {
      revision: previous.revision + 1,
      autoTranslate: body.autoTranslate as boolean,
      translationLanguage: language === undefined ? previous.translationLanguage : language,
    };
    store.db
      .prepare(
        'INSERT INTO app_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      )
      .run(KEY, JSON.stringify(next));
    return next;
  });
}
