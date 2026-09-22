import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { contextDependencyKey } from './context-dependency.js';
import type { ContextPlan } from '../core/context-plan.js';
import type { RunSnapshot } from '../core/types.js';

/** Forward-only conversion. Huge old diagnostic fields are not part of the new runtime shape. */
export function migrateContextStorage(db: DatabaseSync): void {
  const checkpoints = new Map<string, string>();
  for (const row of db
    .prepare('SELECT id,scope_key,revision,plan,snapshot FROM context_checkpoints')
    .iterate()) {
    const snapshot = JSON.parse(String(row.snapshot));
    const plan = JSON.parse(String(row.plan)) as ContextPlan;
    if (snapshot.kind !== 'helper' && snapshot.profile)
      plan.dependencyKey = contextDependencyKey(snapshot);
    const hash = createHash('sha256')
      .update(
        JSON.stringify([
          row.scope_key,
          row.revision,
          { dependencyKey: plan.dependencyKey, compacted: plan.compacted, summary: plan.summary },
        ])
      )
      .digest('hex');
    db.prepare('UPDATE context_checkpoints SET plan=?,hash=? WHERE id=?').run(
      JSON.stringify(plan),
      hash,
      row.id
    );
    checkpoints.set(String(row.id), hash);
  }
  const updateRefs = (value: any): any => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      value.forEach(updateRefs);
      return value;
    }
    if (typeof value.id === 'string' && typeof value.hash === 'string' && checkpoints.has(value.id))
      value.hash = checkpoints.get(value.id);
    if (value.contextPlan && Array.isArray(value.history) && Array.isArray(value.resources))
      value.contextPlan.dependencyKey = contextDependencyKey(value as RunSnapshot);
    Object.values(value).forEach(updateRefs);
    return value;
  };
  for (const table of ['runs', 'helper_tasks', 'helper_artifact_jobs', 'context_jobs']) {
    for (const row of db.prepare(`SELECT id,snapshot FROM ${table}`).iterate()) {
      if (!row.snapshot) continue;
      db.prepare(`UPDATE ${table} SET snapshot=? WHERE id=?`).run(
        JSON.stringify(updateRefs(JSON.parse(String(row.snapshot)))),
        row.id
      );
    }
  }
  for (const row of db
    .prepare('SELECT id,checkpoint FROM context_jobs WHERE checkpoint IS NOT NULL')
    .iterate())
    db.prepare('UPDATE context_jobs SET checkpoint=? WHERE id=?').run(
      JSON.stringify(updateRefs(JSON.parse(String(row.checkpoint)))),
      row.id
    );
  db.exec(`ALTER TABLE context_checkpoints DROP COLUMN snapshot;
    CREATE TABLE context_commands_next(scope_key TEXT NOT NULL,chat_id TEXT NOT NULL REFERENCES chats(id),request_key TEXT NOT NULL,command_hash TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(scope_key,request_key));`);
  for (const row of db
    .prepare(
      "SELECT scope_key,chat_id,request_key,command,COALESCE(json_extract(result,'$.activeRevision'),0) AS revision FROM context_commands"
    )
    .iterate())
    db.prepare('INSERT INTO context_commands_next VALUES(?,?,?,?,?)').run(
      row.scope_key,
      row.chat_id,
      row.request_key,
      createHash('sha256').update(String(row.command)).digest('hex'),
      row.revision
    );
  db.exec(`DROP TABLE context_commands; ALTER TABLE context_commands_next RENAME TO context_commands;
    CREATE TABLE context_jobs_next(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),branch_id TEXT NOT NULL REFERENCES branches(id),request_key TEXT NOT NULL,command TEXT NOT NULL,status TEXT NOT NULL,snapshot TEXT,checkpoint TEXT,error TEXT,noop INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(chat_id,request_key));
    INSERT INTO context_jobs_next SELECT id,chat_id,branch_id,request_key,command,status,
      CASE WHEN status IN ('queued','running') THEN snapshot ELSE NULL END,checkpoint,error,noop,created_at,updated_at FROM context_jobs;
    DROP TABLE context_jobs; ALTER TABLE context_jobs_next RENAME TO context_jobs;
    CREATE UNIQUE INDEX one_active_context_job ON context_jobs(branch_id) WHERE status IN ('queued','running');
    CREATE TABLE variable_journal_next(chat_id TEXT NOT NULL,branch_id TEXT NOT NULL,request_key TEXT NOT NULL,payload_hash TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(chat_id,branch_id,request_key));
    INSERT INTO variable_journal_next SELECT chat_id,branch_id,request_key,payload_hash,COALESCE(json_extract(result,'$.revision'),0),created_at FROM chat_variable_journal;
    DROP TABLE chat_variable_journal; ALTER TABLE variable_journal_next RENAME TO chat_variable_journal;
    UPDATE attempts SET request=json_object('role',role,'modelId',model_id),response=json_object('status',status,'error',error)
      WHERE id IN (SELECT attempt_id FROM context_job_attempts x JOIN context_jobs j ON j.id=x.job_id WHERE j.status NOT IN ('queued','running')) AND status!='running';`);
}
