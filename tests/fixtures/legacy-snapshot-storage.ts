import type { DatabaseSync } from 'node:sqlite';

// Frozen from main e9a1aff8; do not replace with the new schema generator.
const refsKey = '__snapshot_texts_v1';
export function initLegacySnapshotStorage(db: DatabaseSync): void {
  db.exec(`CREATE TABLE snapshot_texts(hash TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE snapshot_text_refs(owner_table TEXT NOT NULL,owner_id TEXT NOT NULL,hash TEXT NOT NULL REFERENCES snapshot_texts(hash),PRIMARY KEY(owner_table,owner_id,hash));
    CREATE INDEX snapshot_text_refs_hash ON snapshot_text_refs(hash);
    CREATE TRIGGER snapshot_text_immutable BEFORE UPDATE ON snapshot_texts BEGIN SELECT RAISE(ABORT,'Immutable snapshot text'); END;`);
  for (const table of [
    'runs',
    'context_checkpoints',
    'context_jobs',
    'helper_tasks',
    'helper_artifact_jobs',
    'helper_artifacts',
  ]) {
    const owner = (row: string) =>
      table === 'helper_artifacts' ? `json_array(${row}.id,${row}.revision)` : `${row}.id`;
    for (const event of ['INSERT', 'UPDATE OF snapshot']) {
      const suffix = event.startsWith('UPDATE') ? 'update' : 'insert';
      db.exec(`CREATE TRIGGER ${table}_snapshot_${suffix} AFTER ${event} ON ${table}
        WHEN json_type(NEW.snapshot,'$.${refsKey}') IS NULL
        BEGIN
          UPDATE ${table} SET snapshot=snapshot_pack(NEW.snapshot) WHERE rowid=NEW.rowid;
        END;
        CREATE TRIGGER ${table}_snapshot_refs_${suffix} AFTER ${event} ON ${table}
        WHEN json_type(NEW.snapshot,'$.${refsKey}') = 'object'
        BEGIN
          DELETE FROM snapshot_text_refs WHERE owner_table='${table}' AND owner_id=${owner('NEW')};
          INSERT INTO snapshot_text_refs SELECT '${table}',${owner('NEW')},value FROM json_each(NEW.snapshot,'$.${refsKey}') GROUP BY value;
          DELETE FROM snapshot_texts WHERE NOT EXISTS(SELECT 1 FROM snapshot_text_refs WHERE hash=snapshot_texts.hash);
        END;`);
    }
    db.exec(`CREATE TRIGGER ${table}_snapshot_delete AFTER DELETE ON ${table} BEGIN
      DELETE FROM snapshot_text_refs WHERE owner_table='${table}' AND owner_id=${owner('OLD')};
      DELETE FROM snapshot_texts WHERE NOT EXISTS(SELECT 1 FROM snapshot_text_refs WHERE hash=snapshot_texts.hash);
    END;`);
  }
}
