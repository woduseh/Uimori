import type { LoreContextSnapshot, RetainedLore } from '../core/lore-context.js';
import type { Run, Source } from '../core/types.js';
import type { Store } from './store.js';

export type LoreRetentionState = {
  sourceId: string;
  sourceHash: string;
  context: LoreContextSnapshot;
  reads: RetainedLore[];
};

export function readLoreRetention(store: Store, run: Run): LoreRetentionState | undefined {
  const row = store.db
    .prepare('SELECT body FROM chat_lore_state WHERE chat_id=? AND branch_id=? AND source_id=?')
    .get(run.chatId, run.snapshot.branchId ?? `main:${run.chatId}`, run.sourceRevision ?? '');
  return row ? (JSON.parse(String(row.body)) as LoreRetentionState) : undefined;
}

/** One active state per branch; old provider packets are not needed to remember successful reads. */
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
  };
  store.db
    .prepare(`INSERT INTO chat_lore_state(chat_id,branch_id,source_id,body) VALUES(?,?,?,?)
    ON CONFLICT(chat_id,branch_id) DO UPDATE SET source_id=excluded.source_id,body=excluded.body`)
    .run(
      run.chatId,
      run.snapshot.branchId ?? `main:${run.chatId}`,
      source.id,
      JSON.stringify(body)
    );
}
