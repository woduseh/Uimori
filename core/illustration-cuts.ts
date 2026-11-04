import type { Illustration } from './illustration.js';

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
    return { key, job, picture, stale: !!job.unplacedMoment || job.sourceHash !== sourceHash };
  });
}
