import type { Job, Source } from '../core/types.js';

/** Failed classifier candidates must never replace a completed translation. */
export function displayTranslationJob(
  source: Pick<Source, 'id' | 'hash'>,
  job?: Job
): Job | undefined {
  if (
    !job ||
    job.kind !== 'translation' ||
    job.sourceRevision !== source.id ||
    job.sourceHash !== source.hash
  )
    return undefined;
  const displayed =
    job.status === 'completed'
      ? job
      : job.previousResult
        ? {
            ...job,
            id: job.previousResult.jobId,
            revision: job.previousResult.revision,
            status: 'completed' as const,
            result: job.previousResult.result,
          }
        : undefined;
  return displayed?.result?.sourceRevision === source.id &&
    displayed.result.sourceHash === source.hash
    ? displayed
    : undefined;
}
