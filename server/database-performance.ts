import type { DatabaseSync } from 'node:sqlite';

/** Query indexes are independent of format admission. Extra indexes do not invalidate user databases. */
export function initDatabaseReadIndexes(db: DatabaseSync): void {
  for (const [name, columns] of [
    ['model_inputs_run_seq', 'model_inputs(run_id,seq)'],
    ['tool_events_run_seq', 'tool_events(run_id,seq)'],
    ['sources_chat', 'sources(chat_id)'],
    ['attempts_run', 'attempts(run_id)'],
    ['attempts_chat_run', 'attempts(chat_id,run_id)'],
    ['runs_retry', "runs(chat_id,json_extract(command,'$.retryOf'),created_at DESC,id DESC)"],
    ['events_kind', 'events(chat_id,kind,seq)'],
    ['jobs_chat_status', 'jobs(chat_id,status)'],
  ])
    db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${columns}`);
}
