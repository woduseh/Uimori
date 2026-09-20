import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** One signing algorithm for fresh initialization, read-only admission and explicit maintenance. */
export function databaseSchemaSignature(db: DatabaseSync): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        db
          .prepare(
            "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
          )
          .all()
      )
    )
    .digest('hex');
}
