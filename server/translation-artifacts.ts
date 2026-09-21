import type { Job, Source } from '../core/types.js';
import { TRANSLATION_TEXT_MAX_CHARS } from '../core/content-limits.js';
import type { Store } from './store.js';
import { HttpError, fields, record, text } from './request-validation.js';

export function successfulTranslation(store: Store, source: Source) {
  const row = store.db
    .prepare(
      "SELECT j.id FROM jobs j JOIN job_results r ON r.job_id=j.id WHERE j.source_revision=? AND j.source_hash=? AND j.kind='translation' AND j.status='completed' ORDER BY j.revision DESC,j.created_at DESC,j.id DESC LIMIT 1"
    )
    .get(source.id, source.hash) as { id: string } | undefined;
  return row ? store.job(row.id) : null;
}
export function validateTranslationArtifact(job: Job, source: Source): void {
  const result = record(job.result);
  fields(result, ['mock', 'manual', 'text', 'sourceRevision', 'sourceHash']);
  if (
    result.sourceRevision !== source.id ||
    result.sourceHash !== source.hash ||
    job.sourceHash !== source.hash ||
    typeof result.mock !== 'boolean'
  )
    throw new HttpError(400, 'Translation dependency mismatch');
  if (result.manual !== undefined && (result.manual !== true || result.mock))
    throw new HttpError(400, 'Invalid authored marker');
  text(result.text, 'translation', TRANSLATION_TEXT_MAX_CHARS);
}
