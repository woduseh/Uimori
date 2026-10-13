import type { FastifyInstance } from 'fastify';
import type { AutoTranslationDefaults } from '../core/chat-settings.js';
import type { DatabaseSync } from 'node:sqlite';
import type { Store } from './store.js';
import { fields, HttpError, number, record } from './request-validation.js';

const KEY = 'auto-translation-defaults';

/** Server-wide default; missing metadata preserves the original opt-in behavior. */
export function autoTranslationDefaults(db: DatabaseSync): AutoTranslationDefaults {
  const row = db.prepare('SELECT value FROM app_metadata WHERE key=?').get(KEY);
  return row
    ? (JSON.parse(String(row.value)) as AutoTranslationDefaults)
    : { revision: 0, autoTranslate: false };
}

export function autoTranslationDefaultRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/auto-translation-defaults', () => autoTranslationDefaults(store.db));
  app.put('/api/auto-translation-defaults', (request) => {
    const body = record(request.body);
    fields(body, ['expectedRevision', 'autoTranslate']);
    const expected = number(body.expectedRevision, 'revision', 0);
    if (typeof body.autoTranslate !== 'boolean')
      throw new HttpError(400, '자동 번역 기본값을 확인해 주세요.');
    return store.transaction(() => {
      const previous = autoTranslationDefaults(store.db);
      if (previous.revision !== expected)
        throw new HttpError(409, '다른 창에서 자동 번역 기본값이 변경됐어요. 다시 불러와 주세요.');
      const next: AutoTranslationDefaults = {
        revision: previous.revision + 1,
        autoTranslate: body.autoTranslate as boolean,
      };
      store.db
        .prepare(
          'INSERT INTO app_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
        )
        .run(KEY, JSON.stringify(next));
      return next;
    });
  });
}
