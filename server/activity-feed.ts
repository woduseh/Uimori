import { createHash } from 'node:crypto';
import type { Store } from './store.js';
import { HttpError } from './request-validation.js';
import { chatActivities } from './chat-activity.js';
import type { ActivityFeed, ActivityFeedItem } from '../core/activity-feed.js';

const baselineKey = 'activity-feed:baseline:v1';
const ackPrefix = (chatId: string) => `activity-feed:ack:v1:${chatId}:`;
const identityKey = (chatId: string, identity: string) =>
  `${ackPrefix(chatId)}${createHash('sha256').update(identity).digest('hex')}`;

/** Schema-15-compatible independent receipts; browser acknowledgement never changes a job. */
export function acknowledgedActivities(store: Store, chatId: string): string[] {
  store.chat(chatId);
  return (
    store.db
      .prepare('SELECT value FROM app_metadata WHERE key LIKE ?')
      .all(`${ackPrefix(chatId)}%`) as { value: string }[]
  ).map((row) => row.value);
}
export function acknowledgeActivities(store: Store, chatId: string, keys: unknown): void {
  store.chat(chatId);
  if (
    !Array.isArray(keys) ||
    keys.length > 100 ||
    keys.some((key) => typeof key !== 'string' || key.length > 1024 || key.length < 2)
  )
    throw new HttpError(400, '확인할 작업 목록이 올바르지 않아요.');
  const save = store.db.prepare('INSERT OR IGNORE INTO app_metadata(key,value) VALUES(?,?)');
  store.transaction(() => {
    for (const key of new Set(keys as string[])) save.run(identityKey(chatId, key), key);
  });
}

type OutcomeRow = {
  id: string;
  chatId: string;
  kind: ActivityFeedItem['kind'];
  status: string;
  at: string;
  startedAt: string;
  sourceId: string | null;
  generation: number;
  autoRunId: string | null;
  uncertain: number;
};
const success = (status: string) => status === 'completed';
function description(row: OutcomeRow): string {
  const name = { main: '본문', translation: '번역', image: '이미지', illustration: '삽화' }[
    row.kind
  ];
  if (row.kind === 'translation' && row.autoRunId)
    return success(row.status)
      ? '원문 · 번역 완료'
      : `자동 번역 ${row.status === 'interrupted' ? '중단' : '실패'} · 원문 확인 가능`;
  if (success(row.status)) return `${name} 완료`;
  if (row.status === 'refused') return `${name} 생성 거절`;
  if (row.status === 'partial') return `${name} 부분 결과 · 확인 필요`;
  if (row.status === 'interrupted') return `${name} 중단 · 상태 확인 필요`;
  return `${name} 실패 · 확인 필요`;
}

/** Startup marker: past successful work stays read, even if the app is opened later. */
export function initializeActivityFeed(store: Store): void {
  store.db
    .prepare('INSERT OR IGNORE INTO app_metadata(key,value) VALUES(?,?)')
    .run(baselineKey, new Date().toISOString());
}

/** Metadata-only all-chat projection; does not require any push subscriptions. */
export function activityFeed(store: Store): ActivityFeed {
  initializeActivityFeed(store);
  const baseline = String(
    store.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(baselineKey)!.value
  );
  const rows = store.db
    .prepare(`
    SELECT r.id,r.chat_id AS chatId,'main' AS kind,r.status,r.updated_at AS at,
      r.created_at AS startedAt,r.source_revision AS sourceId,0 AS generation,
      NULL AS autoRunId,(r.status='interrupted' OR COALESCE(r.error,'') LIKE '%PROVIDER_UNCERTAIN%') AS uncertain
    FROM runs r WHERE r.updated_at>=? AND r.status IN ('completed','failed','partial','refused','interrupted')
      AND (r.status!='completed' OR EXISTS(SELECT 1 FROM attempts a WHERE a.run_id=r.id AND a.is_synthetic=0))
      AND NOT (r.status='completed' AND EXISTS(SELECT 1 FROM jobs j WHERE j.kind='translation' AND json_extract(j.input,'$.autoTranslateRunId')=r.id))
      AND NOT (r.source_revision IS NULL AND EXISTS(SELECT 1 FROM runs newer WHERE newer.chat_id=r.chat_id AND json_extract(newer.command,'$.retryOf')=r.id))
    UNION ALL
    SELECT j.id,j.chat_id,j.kind,j.status,j.updated_at,
      COALESCE((SELECT e.at FROM events e WHERE e.chat_id=j.chat_id AND e.entity_id=j.id AND e.kind='job.queued' ORDER BY e.seq DESC LIMIT 1),j.created_at),
      j.source_revision,j.generation,json_extract(j.input,'$.autoTranslateRunId'),
      (j.status='interrupted' OR COALESCE(j.error,'') LIKE '%PROVIDER_UNCERTAIN%')
    FROM jobs j JOIN sources s ON s.id=j.source_revision
    WHERE j.updated_at>=? AND j.kind IN ('translation','image')
      AND j.status IN ('completed','failed','partial','refused','interrupted')
      AND j.source_hash=COALESCE((SELECT hash FROM source_edits WHERE source_id=s.id ORDER BY revision DESC LIMIT 1),s.hash)
      AND (j.status!='completed' OR EXISTS(SELECT 1 FROM attempts a WHERE a.job_id=j.id AND a.is_synthetic=0))
      AND NOT (j.kind='translation' AND j.status!='completed' AND EXISTS(SELECT 1 FROM jobs newer WHERE newer.kind='translation' AND newer.source_revision=j.source_revision AND newer.source_hash=j.source_hash AND newer.status='completed' AND (newer.revision,newer.created_at,newer.id)>(j.revision,j.created_at,j.id)))
    UNION ALL
    SELECT j.id,j.chat_id,'illustration',j.status,j.updated_at,
      COALESCE((SELECT e.at FROM events e WHERE e.chat_id=j.chat_id AND e.entity_id=j.id AND e.kind='illustration.queued' ORDER BY e.seq DESC LIMIT 1),j.created_at),
      j.source_revision,j.generation,NULL,(j.status='interrupted')
    FROM illustration_jobs j JOIN sources s ON s.id=j.source_revision
    WHERE j.updated_at>=? AND j.status IN ('completed','failed','partial','refused','interrupted')
      AND j.source_hash=COALESCE((SELECT hash FROM source_edits WHERE source_id=s.id ORDER BY revision DESC LIMIT 1),s.hash)
      AND (j.status!='completed' OR EXISTS(SELECT 1 FROM illustration_images i WHERE i.job_id=j.id))
    ORDER BY at DESC,id DESC LIMIT 500
  `)
    .all(baseline, baseline, baseline) as OutcomeRow[];
  const known = new Map<string, Set<string>>();
  const items: ActivityFeedItem[] = [];
  for (const row of rows) {
    if (!known.has(row.chatId))
      known.set(row.chatId, new Set(acknowledgedActivities(store, row.chatId)));
    const acknowledgementKey = JSON.stringify([row.kind, row.id, row.generation, row.startedAt]);
    if (known.get(row.chatId)!.has(acknowledgementKey)) continue;
    items.push({
      chatId: row.chatId,
      acknowledgementKey,
      kind: row.kind,
      status: row.status,
      label: description(row),
      at: row.at,
      sourceId: row.sourceId,
      representation:
        row.kind === 'translation' && success(row.status) ? 'translation' : 'original',
      actionable: !success(row.status),
      canAcknowledge: !row.uncertain,
    });
  }
  return { items, running: chatActivities(store) };
}
