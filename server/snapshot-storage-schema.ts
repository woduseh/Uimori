/** Trusted schema names only. Legacy definitions identify the pre-optimization physical layout. */
export function snapshotStorageTriggers(legacy = false): { name: string; sql: string }[] {
  const refsKey = '__snapshot_texts_v1';
  const triggers: { name: string; sql: string }[] = [];
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
      const packName = `${table}_snapshot_${suffix}`;
      triggers.push({
        name: packName,
        sql: `CREATE TRIGGER ${packName} AFTER ${event} ON ${table}
          WHEN json_type(NEW.snapshot,'$.${refsKey}') IS NULL
          BEGIN
            UPDATE ${table} SET snapshot=snapshot_pack(NEW.snapshot) WHERE rowid=NEW.rowid;
          END;`,
      });
      const refName = `${table}_snapshot_refs_${suffix}`;
      const references = legacy
        ? `DELETE FROM snapshot_text_refs WHERE owner_table='${table}' AND owner_id=${owner('NEW')};
           INSERT INTO snapshot_text_refs SELECT '${table}',${owner('NEW')},value FROM json_each(NEW.snapshot,'$.${refsKey}') GROUP BY value;
           DELETE FROM snapshot_texts WHERE NOT EXISTS(SELECT 1 FROM snapshot_text_refs WHERE hash=snapshot_texts.hash);`
        : `INSERT INTO snapshot_text_refs
             SELECT '${table}',${owner('NEW')},value FROM json_each(NEW.snapshot,'$.${refsKey}')
             WHERE NOT EXISTS(SELECT 1 FROM snapshot_text_refs r
               WHERE r.owner_table='${table}' AND r.owner_id=${owner('NEW')} AND r.hash=value)
             GROUP BY value;
           DELETE FROM snapshot_text_refs
             WHERE owner_table='${table}' AND owner_id=${owner('NEW')}
               AND hash NOT IN (SELECT value FROM json_each(NEW.snapshot,'$.${refsKey}'));`;
      // Add new references before removing obsolete ones. No temporary loss of shared ownership.
      // The reference table, not OLD.snapshot, also covers nested packing of expanded JSON writes.
      triggers.push({
        name: refName,
        sql: `CREATE TRIGGER ${refName} AFTER ${event} ON ${table}
          WHEN json_type(NEW.snapshot,'$.${refsKey}') = 'object'
          BEGIN
            ${references}
          END;`,
      });
    }
    const name = `${table}_snapshot_delete`;
    triggers.push({
      name,
      sql: `CREATE TRIGGER ${name} AFTER DELETE ON ${table} BEGIN
        DELETE FROM snapshot_text_refs WHERE owner_table='${table}' AND owner_id=${owner('OLD')};
        ${legacy ? 'DELETE FROM snapshot_texts WHERE NOT EXISTS(SELECT 1 FROM snapshot_text_refs WHERE hash=snapshot_texts.hash);' : ''}
      END;`,
    });
  }
  if (!legacy)
    triggers.push({
      name: 'snapshot_text_ref_delete',
      sql: `CREATE TRIGGER snapshot_text_ref_delete AFTER DELETE ON snapshot_text_refs BEGIN
        DELETE FROM snapshot_texts WHERE hash=OLD.hash
          AND NOT EXISTS(SELECT 1 FROM snapshot_text_refs WHERE hash=OLD.hash);
      END;`,
    });
  return triggers;
}
