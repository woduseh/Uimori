import type { DatabaseSync } from 'node:sqlite';

/** Join the content save transaction; retain one invalidation for every existing chat. */
export function recordContentProfileEvents(db: DatabaseSync): void {
  db.prepare(`INSERT INTO events(chat_id,kind,entity_id,at)
    SELECT id,'profile.updated',id,? FROM chats ORDER BY created_at,id`).run(
    new Date().toISOString()
  );
}
