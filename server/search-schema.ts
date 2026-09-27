import type { DatabaseSync } from 'node:sqlite';

/** Only invalidation belongs to manuscript transactions. Expensive normalization is deferred;
 * searches overlay dirty sources, so a stale index never hides a just-saved edit. */
export function initManuscriptSearch(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_documents(
      id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, kind TEXT NOT NULL,
      content_hash TEXT NOT NULL, text TEXT NOT NULL, search_text TEXT NOT NULL, UNIQUE(source_id,kind));
    CREATE INDEX IF NOT EXISTS search_documents_chat ON search_documents(chat_id,source_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(search_text,content='search_documents',content_rowid='id',tokenize='trigram');
    CREATE TABLE IF NOT EXISTS search_dirty_sources(source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,revision INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS search_document_insert AFTER INSERT ON search_documents BEGIN
      INSERT INTO search_fts(rowid,search_text) VALUES(new.id,new.search_text); END;
    CREATE TRIGGER IF NOT EXISTS search_document_delete AFTER DELETE ON search_documents BEGIN
      INSERT INTO search_fts(search_fts,rowid,search_text) VALUES('delete',old.id,old.search_text); END;
    CREATE TRIGGER IF NOT EXISTS search_document_update AFTER UPDATE OF search_text ON search_documents BEGIN
      INSERT INTO search_fts(search_fts,rowid,search_text) VALUES('delete',old.id,old.search_text);
      INSERT INTO search_fts(rowid,search_text) VALUES(new.id,new.search_text); END;
    INSERT OR IGNORE INTO app_metadata(key,value) VALUES('search-revision','0');
  `);
  const invalidate = (source: string) => `
    INSERT INTO search_dirty_sources(source_id,revision)
      SELECT id,1 FROM sources WHERE id=${source}
      ON CONFLICT(source_id) DO UPDATE SET revision=revision+1;
    UPDATE app_metadata SET value=CAST(value AS INTEGER)+1 WHERE key='search-revision';`;
  for (const [table, source, events] of [
    ['sources', 'id', ['INSERT', 'UPDATE OF text,hash']],
    ['source_edits', 'source_id', ['INSERT', 'UPDATE', 'DELETE']],
    ['jobs', 'source_revision', ['INSERT', 'UPDATE OF status,source_hash,revision', 'DELETE']],
  ] as const) {
    for (const event of events) {
      const action = event.split(' ')[0];
      const row = action === 'DELETE' ? 'old' : 'new';
      const guard = table === 'jobs' ? `WHEN ${row}.kind='translation'` : '';
      db.exec(`CREATE TRIGGER IF NOT EXISTS search_${table}_${action.toLowerCase()} AFTER ${event} ON ${table} ${guard}
        BEGIN ${invalidate(`${row}.${source}`)} END;`);
    }
  }
  for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
    const row = action === 'DELETE' ? 'old' : 'new';
    db.exec(`CREATE TRIGGER IF NOT EXISTS search_job_result_${action.toLowerCase()} AFTER ${action} ON job_results WHEN EXISTS(SELECT 1 FROM jobs WHERE id=${row}.job_id AND kind='translation')
      BEGIN ${invalidate(`(SELECT source_revision FROM jobs WHERE id=${row}.job_id AND kind='translation')`)} END;`);
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS search_request_update AFTER UPDATE OF request ON runs BEGIN
      ${invalidate('new.source_revision')} END;
    CREATE TRIGGER IF NOT EXISTS search_source_delete AFTER DELETE ON sources BEGIN
      UPDATE app_metadata SET value=CAST(value AS INTEGER)+1 WHERE key='search-revision'; END;
    CREATE TRIGGER IF NOT EXISTS search_branch_move AFTER UPDATE OF head_revision ON branches BEGIN
      UPDATE app_metadata SET value=CAST(value AS INTEGER)+1 WHERE key='search-revision'; END;
  `);
  db.exec(`INSERT OR IGNORE INTO search_dirty_sources(source_id,revision) SELECT id,1 FROM sources
    WHERE NOT EXISTS(SELECT 1 FROM search_documents d WHERE d.source_id=sources.id);`);
}
