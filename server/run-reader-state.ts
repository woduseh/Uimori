import type { Store } from './store.js';
import { HttpError } from './request-validation.js';
import { canDismissReaderRun } from '../core/reader-conversation.js';
import type { Run } from '../core/types.js';

export const RUN_READER_DISMISSAL_PREFIX = 'reader-dismissed-run:v1:';
export const readerRunDismissalKey = (chatId: string, runId: string) =>
  `${RUN_READER_DISMISSAL_PREFIX}${chatId}:${runId}`;

/** Reader presentation only: execution records and their retry receipts stay intact. */
export function dismissReaderRun(store: Store, runId: string) {
  return store.transaction(() => {
    const run = store.db
      .prepare(
        'SELECT chat_id AS chatId,status,source_revision AS sourceRevision,error FROM runs WHERE id=?'
      )
      .get(runId) as
      | {
          chatId: string;
          status: Run['status'];
          sourceRevision: string | null;
          error: string | null;
        }
      | undefined;
    if (!run) throw new HttpError(404, 'Run not found');
    if (!canDismissReaderRun(run))
      throw new HttpError(409, 'Only a cancelled request can be dismissed from the reader');
    const changed = store.db
      .prepare('INSERT OR IGNORE INTO app_metadata(key,value) VALUES(?,?)')
      .run(readerRunDismissalKey(run.chatId, runId), '1');
    if (changed.changes) store.event(run.chatId, 'reader.run-dismissed', runId);
    return { chatId: run.chatId, runId, readerDismissed: true as const };
  });
}
