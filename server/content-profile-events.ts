import type { DatabaseSync } from 'node:sqlite';
import { recordPromptWorkspaceUpdate } from './prompt-workspace-events.js';

export function recordContentProfileEvents(db: DatabaseSync, kind: string, id: string): void {
  const at = new Date().toISOString();
  if (kind === 'prompt-preset') {
    const selected = db
      .prepare(`SELECT 1 FROM prompt_workspace WHERE id=1 AND
      (json_extract(body,'$.main.presetId')=? OR json_extract(body,'$.translation.presetId')=?)`)
      .get(id, id);
    if (selected) {
      db.prepare(
        `UPDATE prompt_workspace SET body=json_set(body,'$.revision',json_extract(body,'$.revision')+1) WHERE id=1`
      ).run();
      recordPromptWorkspaceUpdate(db);
    }
    db.prepare(`INSERT INTO events(chat_id,kind,entity_id,at)
      SELECT chat_id,'profile.updated',chat_id,? FROM profiles
      WHERE json_extract(body,'$.pinned.mainPromptPresetId')=? ORDER BY chat_id`).run(at, id);
    return;
  }
  db.prepare(`WITH RECURSIVE affected(id) AS (
      SELECT ?
      UNION
      SELECT v.id FROM versions v JOIN json_each(v.body,'$.package.modules') m
        JOIN affected a ON json_extract(m.value,'$.id')=a.id WHERE v.kind='content'
    ) INSERT INTO events(chat_id,kind,entity_id,at)
      SELECT p.chat_id,'profile.updated',p.chat_id,? FROM profiles p
      WHERE EXISTS (SELECT 1 FROM json_each(p.body,'$.packageAttachments') r
        JOIN affected a ON json_extract(r.value,'$.id')=a.id)
      ORDER BY p.chat_id`).run(id, at);
}
