import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { translationEndpoints } from '#contracts';
import {
  type AutoTranslationDefaults,
  type SaveAutoTranslationDefaults,
  translationOperations,
} from '#contracts/operations';
import type { Store } from './store.js';
import { assertRevision } from './app-errors.js';
import { registerEndpoint } from './endpoint.js';

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
  registerEndpoint(
    app,
    translationEndpoints.readAutoTranslationDefaults,
    translationOperations.readAutoTranslationDefaults,
    () => autoTranslationDefaults(store.db)
  );
  registerEndpoint(
    app,
    translationEndpoints.saveAutoTranslationDefaults,
    translationOperations.saveAutoTranslationDefaults,
    (input) => saveAutoTranslationDefaults(store, input)
  );
}
export function saveAutoTranslationDefaults(
  store: Store,
  input: SaveAutoTranslationDefaults
): AutoTranslationDefaults {
  return store.transaction(() => {
    const previous = autoTranslationDefaults(store.db);
    assertRevision(previous.revision, input.expectedRevision);
    const next: AutoTranslationDefaults = {
      revision: previous.revision + 1,
      autoTranslate: input.autoTranslate,
      translationLanguage:
        input.translationLanguage === undefined
          ? previous.translationLanguage
          : input.translationLanguage,
    };
    store.db
      .prepare(
        'INSERT INTO app_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      )
      .run(KEY, JSON.stringify(next));
    return next;
  });
}
