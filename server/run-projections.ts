import type { Run, RunSnapshot } from '../core/types.js';
import { HttpError } from './request-validation.js';
import type { Store } from './store.js';

/** Read live execution state without hydrating the snapshot or diagnostic histories. */
export function readRunStatus(store: Pick<Store, 'db'>, id: string): Run['status'] {
  const row = store.db.prepare('SELECT status FROM runs WHERE id=?').get(id) as
    | { status: Run['status'] }
    | undefined;
  if (!row) throw new HttpError(404, 'Run not found');
  return row.status;
}

/** Keep SnapshotDatabase's expansion/integrity checks; each call returns a detached value. */
export function readRunSnapshot(store: Pick<Store, 'db'>, id: string): RunSnapshot {
  const row = store.db.prepare('SELECT snapshot FROM runs WHERE id=?').get(id) as
    | { snapshot: string }
    | undefined;
  if (!row) throw new HttpError(404, 'Run not found');
  return JSON.parse(row.snapshot);
}
