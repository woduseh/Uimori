import type { DatabaseSync } from 'node:sqlite';

export const foldSearchText = (text: string) => text.normalize('NFC').toLowerCase();

export function initSearchTrigrams(db: DatabaseSync) {
  const legacy = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='search_fts'").get();
  db.exec(`SAVEPOINT search_trigrams;
    ${
      legacy
        ? `INSERT INTO search_dirty_sources(source_id,revision)
      SELECT DISTINCT source_id,1 FROM search_documents WHERE search_text<>''
      ON CONFLICT(source_id) DO UPDATE SET revision=revision+1;`
        : ''
    }
    CREATE VIRTUAL TABLE IF NOT EXISTS search_trigrams USING fts5(text,content='',contentless_delete=1,tokenize='trigram',detail=none);
    DROP TRIGGER IF EXISTS search_document_insert;
    DROP TRIGGER IF EXISTS search_document_update;
    DROP TRIGGER IF EXISTS search_document_delete;
    DROP TABLE IF EXISTS search_fts;
    CREATE TRIGGER search_document_delete AFTER DELETE ON search_documents BEGIN
      DELETE FROM search_trigrams WHERE rowid=old.id; END;
    RELEASE search_trigrams;`);
}

export function initManuscriptSearch(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_documents(
      id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, kind TEXT NOT NULL,
      content_hash TEXT NOT NULL, text TEXT NOT NULL, search_text TEXT NOT NULL, UNIQUE(source_id,kind));
    CREATE INDEX IF NOT EXISTS search_documents_chat ON search_documents(chat_id,source_id);
    CREATE TABLE IF NOT EXISTS search_dirty_sources(source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,revision INTEGER NOT NULL);
  `);
  initSearchTrigrams(db);
  const invalidate = (source: string) => `
    INSERT INTO search_dirty_sources(source_id,revision)
      SELECT id,1 FROM sources WHERE id=${source}
      ON CONFLICT(source_id) DO UPDATE SET revision=revision+1;`;
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

  `);
  db.exec(`INSERT OR IGNORE INTO search_dirty_sources(source_id,revision) SELECT id,1 FROM sources
    WHERE NOT EXISTS(SELECT 1 FROM search_documents d WHERE d.source_id=sources.id);`);
}
