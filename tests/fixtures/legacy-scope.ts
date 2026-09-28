import type { DatabaseSync } from 'node:sqlite';

/** Restore the actual pre-14 columns when a test reconstructs an older database. */
export function legacyScopeColumns(db: DatabaseSync) {
  db.exec(`ALTER TABLE branches ADD COLUMN title TEXT NOT NULL DEFAULT '기본 분기';
    ALTER TABLE branches ADD COLUMN head_revision TEXT REFERENCES sources(id);
    ALTER TABLE branches ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE branches ADD COLUMN is_default INTEGER NOT NULL DEFAULT 1;
    UPDATE branches SET head_revision=(SELECT head_revision FROM chats WHERE id=chat_id);
    CREATE UNIQUE INDEX default_branch ON branches(chat_id) WHERE is_default=1;`);
}
