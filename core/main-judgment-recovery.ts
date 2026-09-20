import type { Run } from './types.js';

export function canRecoverMainJudgment(
  run: Pick<Run, 'status' | 'error' | 'snapshot' | 'partialText' | 'sourceRevision'>
): boolean {
  return (
    run.status === 'failed' &&
    !!run.error?.startsWith('JEV_') &&
    !run.sourceRevision &&
    run.snapshot.mainJudgmentEnabled !== false &&
    !!run.snapshot.mainJudgment &&
    run.partialText === run.snapshot.mainJudgment.response &&
    !run.snapshot.nativeRisuExecution?.output
  );
}
