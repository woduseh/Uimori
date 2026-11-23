import type { DatabaseSync } from 'node:sqlite';

export const foldSearchText = (text: string) => text.normalize('NFC').toLowerCase();

// https://sqlite.org/fts5.html#the_columnsize_option (2026-11-23): search_fts keeps one
// search_fts_docsize row per indexed document, so it lists the rows still in the legacy index.
export function moveLegacySearchIndex(db: DatabaseSync, byteBudget: number): boolean {
  const legacy = db
    .prepare(
      'SELECT z.id FROM search_fts_docsize z JOIN search_documents d ON d.id=z.id ORDER BY z.id LIMIT 64'
    )
    .all()
    .map((row) => Number(row.id));
  const read = db.prepare('SELECT search_text FROM search_documents WHERE id=?');
  const indexTrigrams = db.prepare('INSERT INTO search_trigrams(rowid,text) VALUES(?,?)');
  const clear = db.prepare("UPDATE search_documents SET search_text='' WHERE id=?");
  let bytes = 0;
  for (const id of legacy) {
    const text = String(read.get(id)!.search_text);
    indexTrigrams.run(id, text);
    clear.run(id);
    bytes += Buffer.byteLength(text);
    if (bytes >= byteBudget) return true;
  }
  if (legacy.length === 64) return true;
  if (db.prepare('SELECT 1 FROM search_fts_idx LIMIT 1').get())
    db.exec("INSERT INTO search_fts(search_fts) VALUES('delete-all')");
  return false;
}

export function initSearchTrigrams(db: DatabaseSync) {
  db.exec(`SAVEPOINT search_trigrams;
    CREATE VIRTUAL TABLE IF NOT EXISTS search_trigrams USING fts5(text,content='',contentless_delete=1,tokenize='trigram',detail=none);
    DROP TRIGGER IF EXISTS search_document_insert;
    DROP TRIGGER IF EXISTS search_document_delete;
    DROP TRIGGER IF EXISTS search_document_update;
    CREATE TRIGGER search_document_insert AFTER INSERT ON search_documents WHEN new.search_text<>'' BEGIN
      INSERT INTO search_fts(rowid,search_text) VALUES(new.id,new.search_text); END;
    CREATE TRIGGER search_document_delete AFTER DELETE ON search_documents BEGIN
      INSERT INTO search_fts(search_fts,rowid,search_text) SELECT 'delete',old.id,old.search_text WHERE old.search_text<>'';
      DELETE FROM search_trigrams WHERE rowid=old.id AND old.search_text=''; END;
    CREATE TRIGGER search_document_update AFTER UPDATE OF search_text ON search_documents BEGIN
      INSERT INTO search_fts(search_fts,rowid,search_text) SELECT 'delete',old.id,old.search_text WHERE old.search_text<>'';
      INSERT INTO search_fts(rowid,search_text) SELECT new.id,new.search_text WHERE new.search_text<>''; END;
    RELEASE search_trigrams;`);
}

export function initManuscriptSearch(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_documents(
      id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, kind TEXT NOT NULL,
      content_hash TEXT NOT NULL, text TEXT NOT NULL, search_text TEXT NOT NULL, UNIQUE(source_id,kind));
    CREATE INDEX IF NOT EXISTS search_documents_chat ON search_documents(chat_id,source_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(search_text,content='search_documents',content_rowid='id',tokenize='trigram');
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
