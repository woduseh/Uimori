import type { Store } from './store.js';
import { AppError } from './app-errors.js';

export const HELPER_READ_PREFIX = 'helper-read:v1:';
export const HELPER_ACTIVITY_EVENT_KINDS =
  "('task.completed','task.failed','task.cancelled','task.interrupted')";

export function markHelperConversationRead(
  store: Store,
  conversationId: string,
  activityEventSeq: number
) {
  let raised = false;
  const result = store.transaction(() => {
    if (!store.db.prepare('SELECT 1 FROM helper_conversations WHERE id=?').get(conversationId))
      throw new AppError(404, 'HELPER_CONVERSATION_NOT_FOUND');
    const latest = Number(
      store.db
        .prepare(
          `SELECT COALESCE(MAX(seq),0) AS seq FROM helper_events WHERE conversation_id=? AND kind IN ${HELPER_ACTIVITY_EVENT_KINDS}`
        )
        .get(conversationId)!.seq
    );
    const key = HELPER_READ_PREFIX + conversationId;
    const sequence = Math.min(activityEventSeq, latest);
    if (sequence > 0)
      raised = !!store.db
        .prepare(
          `INSERT INTO app_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value
          WHERE CAST(excluded.value AS INTEGER) > CAST(app_metadata.value AS INTEGER)`
        )
        .run(key, String(sequence)).changes;
    const row = store.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(key);
    return { readActivityEventSeq: row ? Number(row.value) : 0 };
  });
  if (raised) store.invalidated('helper-list');
  return result;
}

export function forgetHelperConversationRead(store: Store, conversationId: string) {
  store.db.prepare('DELETE FROM app_metadata WHERE key=?').run(HELPER_READ_PREFIX + conversationId);
}

export function forgetChatHelperReads(store: Store, chatId: string) {
  store.db
    .prepare(
      'DELETE FROM app_metadata WHERE key IN (SELECT ? || id FROM helper_conversations WHERE chat_id=?)'
    )
    .run(HELPER_READ_PREFIX, chatId);
}
