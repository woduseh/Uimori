import type { DatabaseSync } from 'node:sqlite';
import { imageDataHashes, queueImageCleanup } from './unused-data.js';

/** Exact captured hashes still needed by unfinished/retryable work, not all completed history. */
function pinnedSourceHashes(db: DatabaseSync): Set<string> {
  const hashes = new Set<string>();
  for (const sql of [
    "SELECT source_hash AS hash FROM jobs WHERE status NOT IN ('completed','stale')",
    "SELECT source_hash AS hash FROM illustration_jobs WHERE status NOT IN ('completed','stale')",
    "SELECT j.source_hash AS hash FROM jobs j JOIN attempts a ON a.job_id=j.id WHERE a.status='running'",
  ])
    for (const row of db.prepare(sql).iterate()) hashes.add(String(row.hash));
  for (const sql of [
    "SELECT snapshot AS body FROM runs WHERE status!='completed'",
    "SELECT snapshot AS body FROM helper_tasks WHERE status!='completed'",
    'SELECT snapshot AS body FROM context_jobs WHERE snapshot IS NOT NULL',
    "SELECT snapshot AS body FROM helper_artifact_jobs WHERE status!='completed'",
    'SELECT plan AS body FROM context_checkpoints WHERE id IN (SELECT checkpoint_id FROM context_heads)',
  ])
    for (const row of db.prepare(sql).iterate()) {
      if (typeof row.body !== 'string') continue;
      for (const value of db
        .prepare("SELECT value FROM json_tree(?) WHERE type='text' AND length(value)=64")
        .iterate(row.body))
        if (/^[a-f0-9]{64}$/u.test(String(value.value))) hashes.add(String(value.value));
    }
  return hashes;
}

/** The authored original remains a message identity; edits retain two versions and actual captures. */
export function pruneSourceEdits(db: DatabaseSync, sourceId?: string): void {
  const candidates = db
    .prepare(`SELECT source_id,revision,text,hash FROM source_edits e
    WHERE ${sourceId ? 'source_id=? AND' : ''} revision NOT IN
      (SELECT revision FROM source_edits WHERE source_id=e.source_id ORDER BY revision DESC LIMIT 2)`)
    .all(...(sourceId ? [sourceId] : []));
  if (!candidates.length) return;
  const pinned = pinnedSourceHashes(db);
  const remove = db.prepare('DELETE FROM source_edits WHERE source_id=? AND revision=?');
  for (const row of candidates)
    if (!pinned.has(String(row.hash))) {
      queueImageCleanup(db, imageDataHashes(row.text));
      remove.run(row.source_id, row.revision);
    }
}

/** Keep current/previous successful text, active retries and image targets; keep billing metadata separately. */
export function pruneTranslationHistory(db: DatabaseSync, sourceId: string): void {
  const jobs = db
    .prepare(`SELECT j.id,j.status,j.revision,r.result FROM jobs j LEFT JOIN job_results r ON r.job_id=j.id
    WHERE j.source_revision=? AND j.kind='translation' ORDER BY j.revision DESC`)
    .all(sourceId);
  if (jobs.length <= 2) return;
  const keep = new Set<string>([String(jobs[0].id)]);
  for (const row of jobs
    .filter((row) => row.result && ['completed', 'stale'].includes(String(row.status)))
    .slice(0, 2))
    keep.add(String(row.id));
  for (const row of jobs)
    if (!['completed', 'stale'].includes(String(row.status))) keep.add(String(row.id));
  for (const row of db
    .prepare(`SELECT json_extract(input,'$.imageTarget.translationJobId') AS id
    FROM jobs WHERE source_revision=? AND kind='image' AND status!='stale'`)
    .all(sourceId))
    if (row.id) keep.add(String(row.id));
  for (const row of db
    .prepare("SELECT job_id AS id FROM attempts WHERE status='running' AND job_id IS NOT NULL")
    .iterate())
    keep.add(String(row.id));
  for (const row of jobs) {
    const id = String(row.id);
    if (keep.has(id)) continue;
    if (row.result) queueImageCleanup(db, imageDataHashes(row.result));
    db.prepare('DELETE FROM job_results WHERE job_id=?').run(id);
    // A billed call remains as compact execution metadata. Manual edit-only rows have no such use.
    if (db.prepare('SELECT 1 FROM attempts WHERE job_id=? LIMIT 1').get(id))
      db.prepare('UPDATE jobs SET input=NULL WHERE id=?').run(id);
    else db.prepare('DELETE FROM jobs WHERE id=?').run(id);
  }
}

export function pruneSavedTextHistory(db: DatabaseSync): void {
  pruneSourceEdits(db);
  for (const row of db
    .prepare(
      "SELECT source_revision FROM jobs WHERE kind='translation' GROUP BY source_revision HAVING COUNT(*)>2"
    )
    .all())
    pruneTranslationHistory(db, String(row.source_revision));
}
