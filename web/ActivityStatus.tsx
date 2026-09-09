import { useEffect, useRef, useState } from 'react';
import type { ReaderActivity } from '../core/types.js';
import type { RequestActivity } from './useStory.js';
import { ActivityNotifications } from './ActivityNotifications.js';
import { ActivityBar } from './ActivityBar.js';
import {
  activityActive as active,
  activitySuccess as success,
  activityAcknowledgementKey,
  canAcknowledge,
  readAcknowledgements,
  translationResolved,
  type ActivityNoticeItem as Item,
} from './activity-notices.js';
import './activity-status.css';

type Notice = { item: Item; expiresAt: number | null };

function reconcileHistory(history: ReaderActivity[], current: ReaderActivity[]) {
  const live = new Map(current.map((item) => [item.id, item]));
  const next = history.flatMap((item) => {
    const updated = live.get(item.id);
    // The reader includes every active job. A historical active snapshot cannot
    // keep a spinner alive after the job leaves that authoritative projection.
    return updated ? [updated] : active(item.status) ? [] : [item];
  });
  return JSON.stringify(next) === JSON.stringify(history) ? history : next;
}
const names: Record<string, string> = {
  main: '장면을 쓰는 중',
  translation: '번역하는 중',
  image: '이미지 만드는 중',
  status: '상태 정리 중',
  state: '상태 정리 중',
  context: '문맥 압축 중',
  illustration: '삽화 만드는 중',
};
const doneNames: Record<string, string> = {
  main: '본문',
  translation: '번역',
  image: '이미지',
  status: '상태 정리',
  state: '상태 정리',
  context: '문맥 압축',
  illustration: '삽화',
  request: '요청',
};
export function elapsedLabel(start: string, end: number) {
  const timestamp = Date.parse(start);
  if (!Number.isFinite(timestamp) || !Number.isFinite(end)) return '';
  const seconds = Math.max(0, Math.floor((end - timestamp) / 1000));
  return seconds < 60 ? `${seconds}초` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}
function message(item: Item) {
  const prefix = item.otherBranch ? '다른 전개 · ' : '';
  const name = doneNames[item.kind] ?? '작업';
  const status =
    item.status === 'sending'
      ? '요청을 보내는 중'
      : item.status === 'accepted'
        ? '요청 수락 · 상태 확인 중'
        : item.status === 'uncertain'
          ? '요청 수락 여부 확인 필요'
          : item.status === 'waiting_for_state'
            ? '상태 정리를 기다리는 중'
            : item.status === 'queued'
              ? `${name} 대기 중`
              : item.status === 'running'
                ? (names[item.kind] ?? '작업 중')
                : item.status === 'completed'
                  ? `${name} 완료`
                  : item.status === 'cancelled'
                    ? `${name} 중단됨`
                    : item.status === 'refused'
                      ? `${name} 생성 거절`
                      : item.status === 'interrupted'
                        ? `${name} 중단 · 확인 필요`
                        : item.status === 'partial'
                          ? `${name} 부분 결과 · 확인 필요`
                          : item.status === 'stale'
                            ? `${name} 자료 변경 · 확인 필요`
                            : `${name} 실패`;
  return prefix + status;
}

/** Status feedback only; hiding never changes or cancels server work. */
export function ActivityStatus({
  chatId,
  activities,
  request,
  branchId,
  connected,
  onDetails,
  scope,
  seenRunIds = [],
}: {
  chatId: string;
  activities: ReaderActivity[];
  request?: RequestActivity;
  branchId?: string;
  connected: boolean;
  onDetails: () => void;
  scope: string;
  /** Pending turns whose failure card the reader has scrolled into view. */
  seenRunIds?: string[];
}) {
  const [now, setNow] = useState(Date.now);
  const [hidden, setHidden] = useState<string[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(`activity-hidden:${scope}`) ?? '[]');
    } catch {
      return [];
    }
  });
  const [notices, setNotices] = useState<Notice[]>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [history, setHistory] = useState<ReaderActivity[]>([]);
  const [acknowledged, setAcknowledged] = useState<string[]>(() => readAcknowledgements(chatId));
  const observed = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    setHistory((old) => reconcileHistory(old, activities));
  }, [activities]);
  const merged = new Map(reconcileHistory(history, activities).map((item) => [item.id, item]));
  for (const item of activities) {
    const previous = merged.get(item.id);
    if (!previous || item.generation > previous.generation || item.updatedAt >= previous.updatedAt)
      merged.set(item.id, item);
  }
  const items: Item[] = [...merged.values()].map((item) => ({
    key: request?.runId === item.id ? request.id : `${item.id}:${item.startedAt}`,
    acknowledgementKey: activityAcknowledgementKey(item),
    status: item.status,
    startedAt: request?.runId === item.id ? request.startedAt : item.startedAt,
    finishedAt: item.finishedAt,
    kind: item.kind,
    otherBranch: !!item.branchId && !!branchId && item.branchId !== branchId,
    runId: item.id,
    sourceRevision: item.sourceRevision,
    sourceHash: item.sourceHash,
    branchId: item.branchId,
    generation: item.generation,
    superseded: item.superseded,
    executionUncertain: item.executionUncertain,
  }));
  if (request && !activities.some((item) => item.id === request.runId))
    items.unshift({
      key: request.id,
      acknowledgementKey: `request:${request.id}`,
      status: request.status,
      startedAt: request.startedAt,
      finishedAt: null,
      kind: 'request',
      otherBranch: false,
      runId: request.runId ?? request.id,
    });
  const serialized = JSON.stringify(items);
  const resolved = items.filter((item) => translationResolved(item, items));
  const resolvedKeys = JSON.stringify(resolved.map((item) => item.acknowledgementKey));
  useEffect(() => {
    const keys = JSON.parse(resolvedKeys) as string[];
    if (keys.length) setAcknowledged((old) => [...new Set([...old, ...keys])]);
  }, [resolvedKeys]);
  useEffect(() => {
    try {
      // Do not evict old confirmations: paging or reloading must not resurrect them.
      sessionStorage.setItem(`activity-acknowledged:${chatId}`, JSON.stringify(acknowledged));
    } catch {
      /* Confirmation still works in this view when browser storage is unavailable. */
    }
  }, [acknowledged, chatId]);
  // An older settled result belongs to its response. Keep active work and uncertain
  // admission visible, but do not let old failures replace the current turn's result.
  const latestMainStart = items
    .filter((item) => !item.otherBranch && ['main', 'request'].includes(item.kind))
    .reduce((latest, item) => Math.max(latest, Date.parse(item.startedAt) || 0), 0);
  useEffect(() => {
    const snapshot = JSON.parse(serialized) as Item[];
    const previous = observed.current;
    const time = Date.now();
    setNotices((old) => {
      const next = old.filter((notice) =>
        snapshot.some(
          (item) =>
            item.acknowledgementKey === notice.item.acknowledgementKey &&
            item.status === notice.item.status &&
            !active(item.status)
        )
      );
      for (const item of snapshot) {
        if (active(item.status)) continue;
        // Do not replay old successful work on opening a chat. Failures remain actionable.
        const newlyFinished = active(previous?.get(item.key) ?? '');
        if (
          !next.some((notice) => notice.item.acknowledgementKey === item.acknowledgementKey) &&
          (!success(item.status) || newlyFinished)
        ) {
          next.push({
            item: { ...item, finishedAt: item.finishedAt ?? new Date(time).toISOString() },
            expiresAt: success(item.status) ? time + 4000 : null,
          });
        }
      }
      return next.map((notice) => ({
        ...notice,
        item:
          snapshot.find((item) => item.acknowledgementKey === notice.item.acknowledgementKey) ??
          notice.item,
      }));
    });
    observed.current = new Map(snapshot.map((item) => [item.key, item.status]));
    setNow(time);
  }, [serialized]);
  const running = items.filter((item) => active(item.status));
  const unresolvedNotices = notices.filter(
    (notice) =>
      (notice.expiresAt === null || notice.expiresAt > now) &&
      !resolved.some((item) => item.acknowledgementKey === notice.item.acknowledgementKey)
  );
  const visibleNotices = unresolvedNotices.filter(
    (notice) =>
      (notice.item.status === 'uncertain' ||
        (!notice.item.otherBranch &&
          (Date.parse(notice.item.startedAt) || 0) >= latestMainStart)) &&
      (notice.expiresAt === null || notice.expiresAt > now) &&
      !acknowledged.includes(notice.item.acknowledgementKey) &&
      !(success(notice.item.status) && hidden.includes(notice.item.key)) &&
      // The failed turn's own card is on screen; the composer row must not repeat it.
      !(
        notice.item.kind === 'main' &&
        !active(notice.item.status) &&
        seenRunIds.includes(notice.item.runId)
      )
  );
  const ticking = running.length > 0 || visibleNotices.some((notice) => notice.expiresAt !== null);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [ticking]);
  useEffect(() => {
    try {
      sessionStorage.setItem(`activity-hidden:${scope}`, JSON.stringify(hidden.slice(-200)));
    } catch {
      /* Hiding still works in this view. */
    }
  }, [hidden, scope]);
  const candidates = [...running, ...visibleNotices.map((notice) => notice.item)];
  const expanded = candidates.filter((item) => !hidden.includes(item.key));
  const item =
    expanded.find(
      (item) => active(item.status) && !item.otherBranch && ['main', 'request'].includes(item.kind)
    ) ??
    expanded.find((item) => active(item.status)) ??
    expanded.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const connectionIssue = !connected && running.length > 0;
  if (!candidates.length && !notificationsOpen) return null;
  const hasIssue =
    connectionIssue ||
    (item
      ? !active(item.status) && !success(item.status)
      : candidates.some((item) => !active(item.status) && !success(item.status)));
  const tone = connectionIssue
    ? 'uncertain'
    : hasIssue
      ? 'issue'
      : running.length
        ? 'running'
        : 'done';
  const label = connectionIssue
    ? '연결 확인 중 · 진행 여부를 확인할 수 없어요'
    : item
      ? message(item)
      : hasIssue
        ? '확인 필요'
        : `작업 ${running.length}`;
  const measured =
    item && !connectionIssue
      ? elapsedLabel(item.startedAt, active(item.status) ? now : Date.parse(item.finishedAt ?? ''))
      : '';
  // A finished task that took under a second has no meaningful duration to show.
  const elapsed = !item || active(item.status) || measured !== '0초' ? measured : '';
  function hide() {
    setHidden((old) => [...new Set([...old, ...candidates.map((item) => item.key)])]);
  }
  function expand() {
    setHidden((old) => old.filter((key) => !candidates.some((item) => item.key === key)));
  }
  function acknowledge(displayed: Item[]) {
    const keys = displayed
      .filter((candidate) => {
        const current = items.find(
          (item) => item.acknowledgementKey === candidate.acknowledgementKey
        );
        return current && canAcknowledge(current);
      })
      .map((item) => item.acknowledgementKey);
    setAcknowledged((old) => [...new Set([...old, ...keys])]);
  }
  const issueSelected = !!item && !active(item.status) && !success(item.status);
  return (
    <>
      {!!candidates.length && (
        <ActivityBar
          tone={tone}
          issue={hasIssue}
          label={label}
          elapsed={elapsed}
          extra={item && candidates.length > 1 ? candidates.length - 1 : 0}
          expanded={issueSelected ? notificationsOpen : !!item}
          collapsed={!item}
          toggleLabel={
            issueSelected ? '작업 알림 보기' : item ? '작업 상태 숨기기' : '작업 상태 펼치기'
          }
          toggleTitle={
            issueSelected
              ? '확인할 작업 알림을 열어요.'
              : item
                ? '상태 표시만 숨겨요. 작업은 계속 진행돼요.'
                : '작업 상태 펼치기'
          }
          onToggle={issueSelected ? () => setNotificationsOpen(true) : item ? hide : expand}
          onDetails={() => setNotificationsOpen(true)}
          testId="activity-status"
        />
      )}
      <ActivityNotifications
        open={notificationsOpen}
        chatId={chatId}
        items={[...running, ...unresolvedNotices.map((notice) => notice.item)]}
        acknowledged={acknowledged}
        message={message}
        onAcknowledge={acknowledge}
        onHistory={(page) =>
          setHistory((old) => {
            const next = new Map(old.map((item) => [item.id, item]));
            for (const item of page) next.set(item.id, item);
            return reconcileHistory([...next.values()], activities);
          })
        }
        onClose={() => setNotificationsOpen(false)}
        onRecords={() => {
          setNotificationsOpen(false);
          onDetails();
        }}
      />
    </>
  );
}

export function ActivityDetails({
  activities,
  branchId,
}: {
  activities: ReaderActivity[];
  branchId?: string;
}) {
  const [now, setNow] = useState(Date.now);
  const running = activities.filter((item) => active(item.status));
  useEffect(() => {
    if (!running.length) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running.length]);
  if (!running.length) return null;
  return (
    <section className="activity-list" aria-label="진행 중인 모든 작업">
      <h3>진행 중인 작업 {running.length}개</h3>
      <ul>
        {running.map((item) => (
          <li key={item.id}>
            <span>
              {message({
                key: item.id,
                acknowledgementKey: activityAcknowledgementKey(item),
                kind: item.kind,
                status: item.status,
                startedAt: item.startedAt,
                finishedAt: item.finishedAt,
                otherBranch: !!branchId && !!item.branchId && item.branchId !== branchId,
                runId: item.id,
              })}
            </span>
            <span className="activity-elapsed">{elapsedLabel(item.startedAt, now)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
