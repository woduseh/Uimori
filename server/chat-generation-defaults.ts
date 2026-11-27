import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { chatEndpoints, type UpdateChatGenerationDefaults } from '#contracts';
import { chatOperations } from '#contracts/operations';
import {
  DEFAULT_CHAT_GENERATION_DEFAULTS,
  type ChatGenerationDefaults,
} from '../core/chat-settings.js';
import type { Store } from './store.js';
import { AppError } from './app-errors.js';
import { registerEndpoint } from './endpoint.js';

const KEY = 'chat-generation-defaults';

export function chatGenerationDefaults(db: DatabaseSync): ChatGenerationDefaults {
  const row = db.prepare('SELECT value FROM app_metadata WHERE key=?').get(KEY);
  return row
    ? { ...DEFAULT_CHAT_GENERATION_DEFAULTS, ...(JSON.parse(String(row.value)) as object) }
    : { ...DEFAULT_CHAT_GENERATION_DEFAULTS };
}

export function saveChatGenerationDefaults(
  store: Store,
  { expectedRevision, ...values }: UpdateChatGenerationDefaults
): ChatGenerationDefaults {
  return store.transaction(() => {
    const previous = chatGenerationDefaults(store.db);
    if (previous.revision !== expectedRevision) throw new AppError(409, 'REVISION_CONFLICT');
    const next: ChatGenerationDefaults = {
      revision: previous.revision + 1,
      maxCalls: values.maxCalls,
      storyUi: values.storyUi,
      storyUiStyle: values.storyUiStyle,
      autoRefusalRetryEnabled: values.autoRefusalRetryEnabled ?? previous.autoRefusalRetryEnabled,
      autoRefusalMaxRetries: values.autoRefusalMaxRetries ?? previous.autoRefusalMaxRetries,
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
  registerEndpoint(
    app,
    chatEndpoints.readGenerationDefaults,
    chatOperations.readGenerationDefaults,
    () => chatGenerationDefaults(store.db)
  );
  registerEndpoint(
    app,
    chatEndpoints.updateGenerationDefaults,
    chatOperations.updateGenerationDefaults,
    (input) => saveChatGenerationDefaults(store, input)
  );
}
