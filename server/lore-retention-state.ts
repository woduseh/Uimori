import type { LoreContextSnapshot, RetainedLore } from '../core/lore-context.js';
import type { Run, Source } from '../core/types.js';
import type { Store } from './store.js';

export type LoreRetentionState = {
  sourceId: string;
  sourceHash: string;
  context: LoreContextSnapshot;
  reads: RetainedLore[];
  compacted?: import('../core/context-plan.js').ContextPlan['compacted'];
};

export function readLoreRetention(
  store: Store,
  chatId: string,
  sourceId: string
): LoreRetentionState | undefined {
  const row = store.db
    .prepare('SELECT body FROM chat_lore_state WHERE chat_id=? AND source_id=?')
    .get(chatId, sourceId);
  return row ? (JSON.parse(String(row.body)) as LoreRetentionState) : undefined;
}

export function retainCompletedLore(
  store: Store,
  run: Run,
  source: Source,
  reads: RetainedLore[]
): void {
  if (!run.snapshot.loreContext) return;
  const body: LoreRetentionState = {
    sourceId: source.id,
    sourceHash: source.hash,
    context: run.snapshot.loreContext,
    reads,
    compacted: structuredClone(run.snapshot.contextPlan?.compacted ?? []),
  };
  store.db
    .prepare(`INSERT INTO chat_lore_state(chat_id,source_id,body) VALUES(?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET source_id=excluded.source_id,body=excluded.body`)
    .run(run.chatId, source.id, JSON.stringify(body));
}
