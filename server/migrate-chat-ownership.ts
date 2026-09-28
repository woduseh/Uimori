import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

type Json = Record<string, any>;
const parse = (value: unknown): Json => JSON.parse(String(value));
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Schema 13/14 only, in one transaction with FK enforcement temporarily off. */
export function migrateChatOwnership(db: DatabaseSync, previous: number): void {
  if (
    !db.isTransaction ||
    ![13, 14].includes(previous) ||
    db.prepare('PRAGMA foreign_keys').get()!.foreign_keys !== 0
  )
    throw new Error('DATABASE_CHAT_MIGRATION_PRECONDITION');
  if (
    db
      .prepare(`SELECT c.id FROM chats c LEFT JOIN branches b ON b.chat_id=c.id
    GROUP BY c.id HAVING COUNT(b.id) != 1`)
      .get()
  )
    throw new Error('DATABASE_CHAT_OWNER_MISMATCH');
  if (
    db
      .prepare('SELECT 1 FROM branches b LEFT JOIN chats c ON c.id=b.chat_id WHERE c.id IS NULL')
      .get()
  )
    throw new Error('DATABASE_CHAT_OWNER_MISMATCH');
  if (
    previous === 13 &&
    db
      .prepare(`SELECT 1 FROM branches b JOIN chats c ON c.id=b.chat_id
    WHERE b.is_default != 1 OR b.head_revision IS NOT c.head_revision`)
      .get()
  )
    throw new Error('DATABASE_CHAT_HEAD_MISMATCH');
  const tables = [
    'runs',
    'scene_commands',
    'outline_nodes',
    'outline_batches',
    'context_jobs',
    'helper_conversations',
    'chat_option_pending',
    'chat_lore_state',
    'chat_variable_states',
    'chat_variable_journal',
    'reading_positions',
    'bookmarks',
    'push_outbox',
  ];
  for (const table of tables) {
    if (
      db
        .prepare(`SELECT 1 FROM ${table} t LEFT JOIN branches b ON b.id=t.branch_id
      WHERE t.branch_id IS NOT NULL AND (b.id IS NULL OR b.chat_id IS NOT t.chat_id)`)
        .get()
    )
      throw new Error('DATABASE_CHAT_OWNER_MISMATCH');
  }
  const scopes = new Map<string, string>();
  for (const row of db.prepare('SELECT id,chat_id FROM branches').all())
    scopes.set(`chat:${row.chat_id}:${row.id}`, `chat:${row.chat_id}`);
  const scope = (value: string) => {
    if (value.startsWith('chat:') && !scopes.has(value))
      throw new Error('DATABASE_CONTEXT_SCOPE_MISMATCH');
    return scopes.get(value) ?? value;
  };
  const checkpoints = new Map<string, { previous: string; hash: string }>();
  for (const table of ['context_heads', 'context_commands']) {
    for (const row of db.prepare(`SELECT scope_key FROM ${table}`).all())
      scope(String(row.scope_key));
  }
  for (const row of db
    .prepare('SELECT id,scope_key,revision,hash,plan FROM context_checkpoints')
    .all()) {
    const nextScope = scope(String(row.scope_key));
    if (nextScope === row.scope_key) continue;
    const plan = parse(row.plan);
    const digest = (scopeKey: string) =>
      createHash('sha256')
        .update(
          JSON.stringify([
            scopeKey,
            row.revision,
            {
              dependencyKey: plan.dependencyKey,
              compacted: plan.compacted,
              summary: plan.summary,
            },
          ])
        )
        .digest('hex');
    if (row.hash !== digest(String(row.scope_key)))
      throw new Error('DATABASE_CONTEXT_CHECKPOINT_MISMATCH');
    const hash = digest(nextScope);
    checkpoints.set(String(row.id), { previous: String(row.hash), hash });
    db.prepare('UPDATE context_checkpoints SET scope_key=?,hash=? WHERE id=?').run(
      nextScope,
      hash,
      row.id
    );
  }
  for (const [before, after] of scopes) {
    db.prepare('UPDATE context_heads SET scope_key=? WHERE scope_key=?').run(after, before);
    db.prepare('UPDATE context_commands SET scope_key=? WHERE scope_key=?').run(after, before);
  }
  const checkpoint = (value: Json | undefined | null) => {
    if (!value) return;
    const entry = checkpoints.get(value.id);
    if (!entry) return;
    if (value.hash !== entry.previous) throw new Error('DATABASE_CONTEXT_REFERENCE_MISMATCH');
    value.hash = entry.hash;
  };
  const runSnapshot = (value: Json | undefined) => {
    if (!value) return;
    delete value.branchId;
    if (value.contextBase) {
      value.contextBase.scopeKey = scope(value.contextBase.scopeKey);
      checkpoint(value.contextBase.checkpoint);
    }
    checkpoint(value.contextPlan?.checkpoint);
  };
  const updateJson = (table: string, column: string, mutate: (value: Json) => void) => {
    for (const row of db
      .prepare(`SELECT rowid AS key,${column} AS body FROM ${table} WHERE ${column} IS NOT NULL`)
      .all()) {
      const value = parse(row.body);
      if (!value || typeof value !== 'object') continue;
      mutate(value);
      const next = JSON.stringify(value);
      if (next !== row.body)
        db.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`).run(next, row.key);
    }
  };
  // Only host-owned paths change; authored JSON, variables and provider requests stay exact.
  for (const table of ['runs', 'context_jobs', 'helper_artifact_jobs'])
    updateJson(table, 'snapshot', runSnapshot);
  for (const table of ['runs', 'context_jobs', 'author_note_commands'])
    updateJson(table, 'command', (value) => {
      delete value.branchId;
    });
  updateJson('context_jobs', 'checkpoint', checkpoint);
  updateJson('helper_tasks', 'snapshot', (value) => {
    if (value.scope?.kind === 'chat') delete value.scope.branchId;
    runSnapshot(value.writing);
    checkpoint(value.context?.checkpoint);
  });
  updateJson('jobs', 'input', (value) => {
    runSnapshot(value.snapshot);
  });
  updateJson('chat_option_pending', 'body', (value) => {
    delete value.branchId;
  });
  for (const table of ['reading_positions', 'bookmarks'])
    updateJson(table, 'target', (value) => {
      delete value.branchId;
    });
  for (const row of db.prepare('SELECT id,scope FROM helper_conversations').all()) {
    const value = parse(row.scope);
    if (value.kind !== 'chat') continue;
    delete value.branchId;
    const json = JSON.stringify(value);
    db.prepare('UPDATE helper_conversations SET scope=?,scope_key=? WHERE id=?').run(
      json,
      json,
      row.id
    );
  }
  // Rebuild only composite keys. Explicit rowid copies preserve admission order.
  for (const row of db
    .prepare("SELECT name FROM sqlite_schema WHERE type='index' AND sql LIKE '%branch_id%'")
    .all())
    db.exec(`DROP INDEX ${quote(String(row.name))}`);
  const rebuild = (table: string, definition: string, columns: string) => {
    db.exec(`CREATE TABLE ${table}_next(${definition});
      INSERT INTO ${table}_next(rowid,${columns}) SELECT rowid,${columns} FROM ${table};
      DROP TABLE ${table}; ALTER TABLE ${table}_next RENAME TO ${table};`);
  };
  rebuild(
    'chat_option_pending',
    'id TEXT PRIMARY KEY,chat_id TEXT NOT NULL UNIQUE REFERENCES chats(id) ON DELETE CASCADE,body TEXT NOT NULL',
    'id,chat_id,body'
  );
  rebuild(
    'chat_lore_state',
    'chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,body TEXT NOT NULL',
    'chat_id,source_id,body'
  );
  rebuild(
    'chat_variable_states',
    'chat_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,values_json TEXT NOT NULL',
    'chat_id,revision,values_json'
  );
  rebuild(
    'chat_variable_journal',
    'chat_id TEXT NOT NULL,request_key TEXT NOT NULL,payload_hash TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(chat_id,request_key)',
    'chat_id,request_key,payload_hash,revision,created_at'
  );
  rebuild(
    'reading_positions',
    'client_id TEXT NOT NULL,chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,target TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(client_id,chat_id)',
    'client_id,chat_id,source_id,target,revision,updated_at'
  );
  for (const table of [
    'runs',
    'scene_commands',
    'outline_nodes',
    'outline_batches',
    'context_jobs',
    'helper_conversations',
    'bookmarks',
    'push_outbox',
  ])
    db.exec(`ALTER TABLE ${table} DROP COLUMN branch_id`);
  db.exec(`DROP TABLE branches;
    CREATE UNIQUE INDEX one_active_run_per_chat ON runs(chat_id) WHERE status IN ('queued','running');
    CREATE UNIQUE INDEX one_active_context_job ON context_jobs(chat_id) WHERE status IN ('queued','running');
    CREATE INDEX outline_nodes_chat ON outline_nodes(chat_id,parent_id,position);
    CREATE INDEX helper_conversations_scope ON helper_conversations(chat_id,updated_at);
    CREATE INDEX reading_position_recent ON reading_positions(chat_id,updated_at DESC);
    CREATE INDEX bookmarks_chat ON bookmarks(chat_id,created_at,id);`);
}
