import type { DatabaseSync } from 'node:sqlite';
import type { DraftRevisions } from '../core/edit-drafts.js';
import { HttpError } from './request-validation.js';

/** Never materialize draft bodies or content/preset bodies for an unchanged editor. */
export function editDraftRevisions(db: DatabaseSync, id: string): DraftRevisions {
  const row = db
    .prepare(`SELECT d.revision,
      CASE WHEN d.target_id IS NULL THEN NULL
        WHEN d.kind='prompt-workspace' THEN
          (SELECT json_extract(body,'$.revision') FROM prompt_workspace WHERE id=1)
        ELSE (SELECT v.revision FROM versions v
          WHERE v.kind=d.kind AND v.id=d.target_id ORDER BY v.revision DESC LIMIT 1)
      END AS targetRevision
      FROM edit_drafts d WHERE d.id=?`)
    .get(id) as DraftRevisions | undefined;
  if (!row) throw new HttpError(404, 'Edit draft not found');
  return { revision: row.revision, targetRevision: row.targetRevision };
}
