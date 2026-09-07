import type { ChatActivityCount } from '../core/chat-activity.js';
import type { Store } from './store.js';

/** One grouped read for all chats, including work outside the selected reader page. */
export function chatActivities(store: Store): ChatActivityCount[] {
  return store.db
    .prepare(`WITH active AS (
      SELECT chat_id AS chatId,'main' AS kind FROM runs
        WHERE status IN ('queued','running','waiting_for_state')
      UNION ALL
      SELECT j.chat_id,j.kind FROM jobs j JOIN sources s ON s.id=j.source_revision
        WHERE j.status IN ('queued','running')
        AND j.source_hash=COALESCE((SELECT hash FROM source_edits WHERE source_id=s.id ORDER BY revision DESC LIMIT 1),s.hash)
      UNION ALL
      SELECT j.chat_id,j.kind FROM story_jobs j JOIN sources s ON s.id=j.source_revision
        WHERE j.status IN ('queued','running')
        AND j.source_hash=COALESCE((SELECT hash FROM source_edits WHERE source_id=s.id ORDER BY revision DESC LIMIT 1),s.hash)
    ) SELECT chatId,kind,COUNT(*) AS count FROM active GROUP BY chatId,kind ORDER BY chatId,kind`)
    .all() as ChatActivityCount[];
}
