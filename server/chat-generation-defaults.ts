import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_CHAT_GENERATION_DEFAULTS,
  normalizeChatSettings,
  type ChatGenerationDefaults,
} from '../core/chat-settings.js';
import { fields, HttpError, number, record } from './request-validation.js';
import type { Store } from './store.js';

const KEY = 'chat-generation-defaults';

export function chatGenerationDefaults(db: DatabaseSync): ChatGenerationDefaults {
  const row = db.prepare('SELECT value FROM app_metadata WHERE key=?').get(KEY);
  return row
    ? { ...DEFAULT_CHAT_GENERATION_DEFAULTS, ...(JSON.parse(String(row.value)) as object) }
    : { ...DEFAULT_CHAT_GENERATION_DEFAULTS };
}

export function saveChatGenerationDefaults(store: Store, input: unknown): ChatGenerationDefaults {
  const body = record(input);
  fields(body, [
    'expectedRevision',
    'maxCalls',
    'storyUi',
    'storyUiStyle',
    'autoRefusalRetryEnabled',
    'autoRefusalMaxRetries',
  ]);
  const expected = number(body.expectedRevision, 'revision', 0);
  const { maxCalls, storyUi, storyUiStyle, autoRefusalRetryEnabled, autoRefusalMaxRetries } =
    normalizeChatSettings(body);
  if (storyUi === undefined || storyUiStyle === undefined)
    throw new HttpError(400, '새 채팅 생성 기본값을 확인해 주세요.');

  return store.transaction(() => {
    const previous = chatGenerationDefaults(store.db);
    if (previous.revision !== expected)
      throw new HttpError(409, '다른 창에서 새 채팅 생성 기본값이 변경됐어요. 다시 불러와 주세요.');
    const next: ChatGenerationDefaults = {
      revision: previous.revision + 1,
      maxCalls,
      storyUi,
      storyUiStyle,
      autoRefusalRetryEnabled: autoRefusalRetryEnabled ?? previous.autoRefusalRetryEnabled,
      autoRefusalMaxRetries: autoRefusalMaxRetries ?? previous.autoRefusalMaxRetries,
    };
    store.db
      .prepare(
        'INSERT INTO app_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      )
      .run(KEY, JSON.stringify(next));
    return next;
  });
}

export function chatGenerationDefaultRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/chat-generation-defaults', () => chatGenerationDefaults(store.db));
  app.put('/api/chat-generation-defaults', (request) =>
    saveChatGenerationDefaults(store, request.body)
  );
}
