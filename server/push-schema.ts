import type { DatabaseSync } from 'node:sqlite';

/** This is a notification-only delivery queue, not a second task execution system.
 * The terminal-event enqueue function owns policy, not SQL triggers. */
export function initPushSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions(
      id TEXT PRIMARY KEY,client_id TEXT NOT NULL,session_hash TEXT NOT NULL REFERENCES access_sessions(token_hash) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,keys TEXT NOT NULL,preferences TEXT NOT NULL,origin TEXT NOT NULL,
      revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_error TEXT,
      UNIQUE(session_hash,client_id));
    CREATE TABLE IF NOT EXISTS push_outbox(
      id INTEGER PRIMARY KEY,subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
      event_key TEXT NOT NULL,chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,representation TEXT NOT NULL DEFAULT 'original',status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,next_at TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,
      UNIQUE(subscription_id,event_key));
    CREATE INDEX IF NOT EXISTS push_outbox_due ON push_outbox(status,next_at);
    CREATE INDEX IF NOT EXISTS push_outbox_chat ON push_outbox(chat_id);
  `);
}
