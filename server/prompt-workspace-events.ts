import type { DatabaseSync } from 'node:sqlite';

export const PROMPT_WORKSPACE_UPDATED = 'prompt-workspace.updated';
const LATEST_UPDATE_KEY = 'events:prompt-workspace.updated:v1';

export type PromptWorkspaceUpdate = { seq: number; at: string };

function reserveEventSequence(db: DatabaseSync): number {
  const reserved = db
    .prepare("UPDATE sqlite_sequence SET seq=seq+1 WHERE name='events' RETURNING seq")
    .get() as { seq: number } | undefined;
  if (reserved) return Number(reserved.seq);
  const first = db
    .prepare(
      "INSERT INTO sqlite_sequence(name,seq) SELECT 'events',COALESCE(MAX(seq),0)+1 FROM events RETURNING seq"
    )
    .get() as { seq: number };
  return Number(first.seq);
}

export function recordPromptWorkspaceUpdate(db: DatabaseSync): void {
  const update: PromptWorkspaceUpdate = {
    seq: reserveEventSequence(db),
    at: new Date().toISOString(),
  };
  db.prepare(
    'INSERT INTO app_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(LATEST_UPDATE_KEY, JSON.stringify(update));
}

export function latestPromptWorkspaceUpdate(db: DatabaseSync): PromptWorkspaceUpdate | undefined {
  const row = db.prepare('SELECT value FROM app_metadata WHERE key=?').get(LATEST_UPDATE_KEY) as
    | { value: string }
    | undefined;
  return row ? (JSON.parse(row.value) as PromptWorkspaceUpdate) : undefined;
}
