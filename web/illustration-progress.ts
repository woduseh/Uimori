import { t } from './i18n.js';
import type { Illustration } from '../core/illustration.js';
import { illustrationSkipped } from './illustration-labels.js';

export type Cut = { key: string; job: Illustration; picture?: Illustration; stale: boolean };

/** A target owns one reading position, even while a newer render is pending or failed. */
export function cutsFor(items: Illustration[], sourceHash: string): Cut[] {
  const groups = new Map<string, Illustration[]>();
  for (const item of items) {
    if (item.task !== 'render') continue;
    const key = item.target?.id ?? item.id;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups].map(([key, attempts]) => {
    const last = attempts.at(-1)!;
    const display = last.display ?? attempts.find((item) => item.display)?.display;
    const job = attempts.find((item) => item.id === display?.latestRequestedJobId) ?? last;
    const picture = display
      ? attempts.find((item) => item.id === display.displayedJobId && item.images.length > 0)
      : attempts.findLast((item) => item.status === 'completed' && item.images.length > 0);
    return { key, job, picture, stale: job.sourceHash !== sourceHash };
  });
}

export const illustrationTaskNames = {
  get plan() {
    return t('visuals.m247');
  },
  get render() {
    return t('visuals.m248');
  },
  get placement() {
    return t('visuals.m249');
  },
};

/** A render retry is still one cut. Planning and translation alignment never count as pictures. */
export function illustrationProgress(items: Illustration[]) {
  const plan = items.findLast((item) => item.task === 'plan');
  const placement = items.findLast((item) => item.task === 'placement');
  const cuts = cutsFor(items, items[0]?.sourceHash ?? '');
  const renders = cuts.map((cut) => cut.job);
  const completed = cuts.filter((cut) => cut.job.status === 'completed' && cut.picture).length;
  const unresolved = cuts.filter(
    (cut) => !cut.job.display?.hero && cut.job.display?.translation?.afterAnchor === null
  ).length;
  const failed = renders.filter((job) => ['failed', 'interrupted'].includes(job.status)).length;
  const renderStatus = renders.some((job) => job.status === 'running')
    ? 'running'
    : renders.some((job) => job.status === 'queued')
      ? 'queued'
      : renders.some((job) => ['failed', 'interrupted'].includes(job.status))
        ? 'failed'
        : renders.some((job) => job.status === 'cancelled')
          ? 'cancelled'
          : 'completed';
  const phases: { task: Illustration['task']; status: string; detail: string }[] = [];
  if (plan)
    phases.push({
      task: 'plan',
      status: plan.status,
      detail: illustrationSkipped(plan)
        ? t('visuals.m250', { v0: plan.diagnostic?.skipped ?? '' })
        : '',
    });
  if (renders.length)
    phases.push({
      task: 'render',
      status: renderStatus,
      detail: t('visuals.progressRender', { completed, total: renders.length, failed }),
    });
  if (placement)
    phases.push({
      task: 'placement',
      status: placement.status,
      detail:
        placement.status === 'completed' && unresolved ? t('visuals.m252', { v0: unresolved }) : '',
    });
  const active = phases.find((phase) => ['queued', 'running'].includes(phase.status));
  const issue = phases.find((phase) =>
    ['failed', 'interrupted', 'cancelled'].includes(phase.status)
  );
  const status = active?.status ?? issue?.status ?? (unresolved ? 'partial' : 'completed');
  const summary = active
    ? active.task === 'render'
      ? t('visuals.activeRender', { status: active.status, completed, total: renders.length })
      : t('visuals.phaseStatus', {
          task: illustrationTaskNames[active.task],
          status: active.status,
        })
    : issue
      ? t('visuals.phaseStatus', { task: illustrationTaskNames[issue.task], status: issue.status })
      : unresolved
        ? t('visuals.m258', { v0: unresolved })
        : t('visuals.m259');
  return { phases, status, summary, unresolved };
}
