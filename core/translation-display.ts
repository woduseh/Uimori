import type { Job, Source } from './types.js';

export function latestTranslation(source: Pick<Source, 'id' | 'hash'>, jobs: readonly Job[]) {
  return jobs
    .filter(
      (job) =>
        job.kind === 'translation' &&
        job.sourceRevision === source.id &&
        job.sourceHash === source.hash &&
        job.status !== 'stale'
    )
    .sort((a, b) => (b.revision ?? 1) - (a.revision ?? 1))
    .at(0);
}

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
            translationLayout: job.previousResult.translationLayout,
          }
        : undefined;
  return displayed?.result?.sourceRevision === source.id &&
    displayed.result.sourceHash === source.hash
    ? displayed
    : undefined;
}
