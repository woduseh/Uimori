import type { DatabaseSync } from 'node:sqlite';
import { pushAllowed, type PushEnvelope, type PushPreferences } from '../core/push.js';

type Target = {
  status: string;
  branch_id: string | null;
  source_id: string | null;
  generation: number;
  eligible: number;
};

/** Called only while recording a real event, in the same database transaction.
 * It never scans old events, starts model work, or sends over the network. */
export function enqueueTerminalNotification(
  db: DatabaseSync,
  chatId: string,
  event: string,
  entityId: string,
  at: string
) {
  const [family, status] = event.split('.');
  if (event !== `${family}.${status}`) return;
  if (
    !['run', 'job', 'illustration'].includes(family) ||
    !['completed', 'failed', 'partial', 'refused', 'interrupted'].includes(status)
  )
    return;
  const subscriptions = db.prepare('SELECT id,preferences FROM push_subscriptions').all();
  if (!subscriptions.length) return;
  let target: Target | undefined;
  let prefix: string;
  let kind: PushEnvelope['kind'];
  const representation = family === 'job' ? 'translation' : 'original';
  if (family === 'run') {
    prefix = 'run';
    kind = status === 'completed' ? 'main-completed' : 'task-failed';
    target = db
      .prepare(`SELECT r.status,COALESCE(r.branch_id,(SELECT id FROM branches WHERE chat_id=r.chat_id)) AS branch_id,
      COALESCE(r.source_revision,r.parent_revision) AS source_id,0 AS generation,
      EXISTS(SELECT 1 FROM attempts a WHERE a.run_id=r.id AND a.is_synthetic=0) AS eligible
      FROM runs r WHERE r.id=? AND r.chat_id=?`)
      .get(entityId, chatId) as Target | undefined;
  } else if (family === 'job') {
    prefix = 'translation';
    kind = status === 'completed' ? 'translation-completed' : 'task-failed';
    target = db
      .prepare(`SELECT j.status,r.branch_id,j.source_revision AS source_id,j.generation,
      (EXISTS(SELECT 1 FROM attempts a WHERE a.job_id=j.id AND a.is_synthetic=0)
      AND EXISTS(SELECT 1 FROM job_results jr WHERE jr.job_id=j.id AND COALESCE(json_extract(jr.result,'$.manual'),0)=0)) AS eligible
      FROM jobs j JOIN sources s ON s.id=j.source_revision JOIN runs r ON r.id=s.run_id
      WHERE j.id=? AND j.chat_id=? AND j.kind='translation'
      AND j.source_hash=COALESCE((SELECT hash FROM source_edits WHERE source_id=s.id ORDER BY revision DESC LIMIT 1),s.hash)`)
      .get(entityId, chatId) as Target | undefined;
  } else {
    prefix = 'illustration';
    kind = status === 'completed' ? 'illustration-completed' : 'task-failed';
    target = db
      .prepare(`SELECT j.status,r.branch_id,j.source_revision AS source_id,j.generation,
      EXISTS(SELECT 1 FROM illustration_images i WHERE i.job_id=j.id) AS eligible
      FROM illustration_jobs j JOIN sources s ON s.id=j.source_revision JOIN runs r ON r.id=s.run_id
      WHERE j.id=? AND j.chat_id=?
      AND j.source_hash=COALESCE((SELECT hash FROM source_edits WHERE source_id=s.id ORDER BY revision DESC LIMIT 1),s.hash)`)
      .get(entityId, chatId) as Target | undefined;
  }
  if (!target || target.status !== status || (status === 'completed' && !target.eligible)) return;
  const eventKey =
    family === 'run'
      ? `${prefix}:${entityId}:${status}`
      : `${prefix}:${entityId}:${target.generation}:${status}`;
  const expiresAt = new Date(Date.parse(at) + 2 * 3600_000).toISOString();
  const insert =
    db.prepare(`INSERT INTO push_outbox(subscription_id,event_key,chat_id,branch_id,source_id,kind,representation,next_at,expires_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(subscription_id,event_key) DO NOTHING`);
  for (const subscription of subscriptions) {
    if (
      pushAllowed(kind, eventKey, JSON.parse(String(subscription.preferences)) as PushPreferences)
    )
      insert.run(
        subscription.id,
        eventKey,
        chatId,
        target.branch_id,
        target.source_id,
        kind,
        representation,
        at,
        expiresAt,
        at
      );
  }
}
