import type { ReaderActivity } from '../core/types.js';

export type ActivityNoticeItem = {
  key: string;
  acknowledgementKey: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  kind: string;
  otherBranch: boolean;
  runId: string;
  sourceRevision?: string | null;
  sourceHash?: string | null;
  branchId?: string | null;
  generation?: number;
  superseded?: boolean;
  executionUncertain?: boolean;
};

export const activityActive = (status: string) =>
  ['sending', 'accepted', 'queued', 'running', 'waiting_for_state'].includes(status);
export const activitySuccess = (status: string) => ['completed', 'cancelled'].includes(status);
export const canAcknowledge = (item: ActivityNoticeItem) =>
  !activityActive(item.status) && item.status !== 'uncertain' && !item.executionUncertain;

export function activityAcknowledgementKey(item: ReaderActivity) {
  return JSON.stringify([item.kind, item.id, item.generation, item.startedAt]);
}

/** Match a successful replacement to the exact source version; never infer across sources. */
export function translationResolved(item: ActivityNoticeItem, items: ActivityNoticeItem[]) {
  if (item.kind !== 'translation' || !canAcknowledge(item) || activitySuccess(item.status))
    return false;
  if (item.superseded) return true;
  return (
    !!item.sourceRevision &&
    !!item.sourceHash &&
    items.some(
      (next) =>
        next.kind === 'translation' &&
        next.status === 'completed' &&
        !next.executionUncertain &&
        next.sourceRevision === item.sourceRevision &&
        next.sourceHash === item.sourceHash &&
        next.branchId === item.branchId &&
        Date.parse(next.startedAt) > Date.parse(item.startedAt)
    )
  );
}

export function readAcknowledgements(scope: string): string[] {
  try {
    const saved: unknown = JSON.parse(
      sessionStorage.getItem(`activity-acknowledged:${scope}`) ?? '[]'
    );
    return Array.isArray(saved)
      ? saved.filter((key): key is string => typeof key === 'string')
      : [];
  } catch {
    return [];
  }
}
