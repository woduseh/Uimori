import type { DatabaseSync } from 'node:sqlite';

/** This is a notification-only delivery queue, not a second task execution system.
 * Terminal event insertion and delivery intent commit together. Reads/reconnects never enqueue. */
export function initPushSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions(
      id TEXT PRIMARY KEY,client_id TEXT NOT NULL,session_hash TEXT NOT NULL REFERENCES access_sessions(token_hash) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,keys TEXT NOT NULL,preferences TEXT NOT NULL,origin TEXT NOT NULL,
      revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_error TEXT,
      UNIQUE(session_hash,client_id));
    CREATE TABLE IF NOT EXISTS push_outbox(
      id INTEGER PRIMARY KEY,subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
      event_key TEXT NOT NULL,chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,representation TEXT NOT NULL DEFAULT 'original',status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,next_at TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,
      UNIQUE(subscription_id,event_key));
    CREATE INDEX IF NOT EXISTS push_outbox_due ON push_outbox(status,next_at);
    CREATE INDEX IF NOT EXISTS push_outbox_chat ON push_outbox(chat_id);
  `);
  const columns =
    '(subscription_id,event_key,chat_id,branch_id,source_id,kind,representation,next_at,expires_at,created_at)';
  const times = "new.at,strftime('%Y-%m-%dT%H:%M:%fZ',new.at,'+2 hours'),new.at";
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS push_main_terminal AFTER INSERT ON events
    WHEN new.kind IN ('run.completed','run.failed','run.partial','run.refused','run.interrupted') BEGIN
      INSERT INTO push_outbox${columns}
      SELECT p.id,'run:'||r.id||':'||r.status,r.chat_id,
        COALESCE(r.branch_id,(SELECT id FROM branches WHERE chat_id=r.chat_id AND is_default=1)),
        COALESCE(r.source_revision,r.parent_revision),
        CASE WHEN r.status='completed' THEN 'main-completed' ELSE 'task-failed' END,'original',${times}
      FROM runs r JOIN push_subscriptions p WHERE r.id=new.entity_id AND r.chat_id=new.chat_id
        AND new.kind='run.'||r.status
        AND ((r.status='completed' AND json_extract(p.preferences,'$.main')=1
          AND EXISTS(SELECT 1 FROM attempts a WHERE a.run_id=r.id AND a.is_synthetic=0))
          OR (r.status!='completed' AND json_extract(p.preferences,'$.failures')=1))
      ON CONFLICT(subscription_id,event_key) DO NOTHING;
    END;
    CREATE TRIGGER IF NOT EXISTS push_translation_terminal AFTER INSERT ON events
    WHEN new.kind IN ('job.completed','job.failed','job.partial','job.interrupted') BEGIN
      INSERT INTO push_outbox${columns}
      SELECT p.id,'translation:'||j.id||':'||j.generation||':'||j.status,j.chat_id,r.branch_id,j.source_revision,
        CASE WHEN j.status='completed' THEN 'translation-completed' ELSE 'task-failed' END,'translation',${times}
      FROM jobs j JOIN sources s ON s.id=j.source_revision JOIN runs r ON r.id=s.run_id JOIN push_subscriptions p
      WHERE j.id=new.entity_id AND j.chat_id=new.chat_id AND j.kind='translation'
        AND new.kind='job.'||j.status AND json_extract(p.preferences,'$.translation')=1
        AND j.source_hash=COALESCE((SELECT hash FROM source_edits WHERE source_id=s.id ORDER BY revision DESC LIMIT 1),s.hash)
        AND ((j.status='completed' AND EXISTS(SELECT 1 FROM attempts a WHERE a.job_id=j.id AND a.is_synthetic=0)
          AND EXISTS(SELECT 1 FROM job_results jr WHERE jr.job_id=j.id AND COALESCE(json_extract(jr.result,'$.manual'),0)=0))
          OR (j.status!='completed' AND json_extract(p.preferences,'$.failures')=1))
      ON CONFLICT(subscription_id,event_key) DO NOTHING;
    END;
    CREATE TRIGGER IF NOT EXISTS push_illustration_terminal AFTER INSERT ON events
    WHEN new.kind IN ('illustration.completed','illustration.failed','illustration.interrupted') BEGIN
      INSERT INTO push_outbox${columns}
      SELECT p.id,'illustration:'||j.id||':'||j.generation||':'||j.status,j.chat_id,r.branch_id,j.source_revision,
        CASE WHEN j.status='completed' THEN 'illustration-completed' ELSE 'task-failed' END,'original',${times}
      FROM illustration_jobs j JOIN sources s ON s.id=j.source_revision JOIN runs r ON r.id=s.run_id JOIN push_subscriptions p
      WHERE j.id=new.entity_id AND j.chat_id=new.chat_id AND new.kind='illustration.'||j.status
        AND json_extract(p.preferences,'$.illustration')=1
        AND j.source_hash=COALESCE((SELECT hash FROM source_edits WHERE source_id=s.id ORDER BY revision DESC LIMIT 1),s.hash)
        AND ((j.status='completed' AND EXISTS(SELECT 1 FROM illustration_images i WHERE i.job_id=j.id))
          OR (j.status!='completed' AND json_extract(p.preferences,'$.failures')=1))
      ON CONFLICT(subscription_id,event_key) DO NOTHING;
    END;
  `);
}
