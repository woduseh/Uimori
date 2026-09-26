import type { Job } from './types.js';

export function canRejudgeTranslation(job: Job): boolean {
  return (
    job.kind === 'translation' &&
    ((job.status === 'failed' &&
      ['TRANSLATION_REFUSAL_CHECK_FAILED', 'JEV_INPUT_BUDGET'].includes(job.error ?? '')) ||
      (job.status === 'interrupted' && job.result?.judgmentPending === true)) &&
    job.result?.mock === false &&
    typeof job.result.text === 'string' &&
    !!job.result.text.trim() &&
    job.result.sourceRevision === job.sourceRevision &&
    job.result.sourceHash === job.sourceHash
  );
}
