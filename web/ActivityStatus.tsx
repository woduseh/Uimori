import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, CircleAlert, LoaderCircle } from 'lucide-react';
import type { ReaderActivity } from '../core/types.js';
import type { RequestActivity } from './useStory.js';
import './activity-status.css';

type Item = {
  key: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  kind: string;
  otherBranch: boolean;
};
type Notice = { item: Item; expiresAt: number | null };
const active = (status: string) =>
  ['sending', 'accepted', 'queued', 'running', 'waiting_for_state'].includes(status);
const success = (status: string) => ['completed', 'cancelled'].includes(status);
const names: Record<string, string> = {
  main: '장면을 쓰는 중',
  translation: '번역하는 중',
  image: '이미지 만드는 중',
  status: '상태 정리 중',
  state: '상태 정리 중',
  memory: '기억 정리 중',
};
const doneNames: Record<string, string> = {
  main: '본문',
  translation: '번역',
  image: '이미지',
  status: '상태 정리',
  state: '상태 정리',
  memory: '기억 정리',
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
  activities,
  request,
  branchId,
  connected,
  onDetails,
  scope,
}: {
  activities: ReaderActivity[];
  request?: RequestActivity;
  branchId?: string;
  connected: boolean;
  onDetails: () => void;
  scope: string;
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
  const observed = useRef<Map<string, string> | null>(null);
  const items: Item[] = activities.map((item) => ({
    key: request?.runId === item.id ? request.id : `${item.id}:${item.startedAt}`,
    status: item.status,
    startedAt: request?.runId === item.id ? request.startedAt : item.startedAt,
    finishedAt: item.finishedAt,
    kind: item.kind,
    otherBranch: !!item.branchId && !!branchId && item.branchId !== branchId,
  }));
  if (request && !activities.some((item) => item.id === request.runId))
    items.unshift({
      key: request.id,
      status: request.status,
      startedAt: request.startedAt,
      finishedAt: null,
      kind: 'request',
      otherBranch: false,
    });
  const serialized = JSON.stringify(items);
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
        snapshot.some((item) => item.key === notice.item.key && !active(item.status))
      );
      for (const item of snapshot) {
        if (active(item.status)) continue;
        // Do not replay old successful work on opening a chat. Failures remain actionable.
        const newlyFinished = active(previous?.get(item.key) ?? '');
        if (
          !next.some((notice) => notice.item.key === item.key) &&
          (!success(item.status) || newlyFinished)
        ) {
          next.push({
            item: { ...item, finishedAt: item.finishedAt ?? new Date(time).toISOString() },
            expiresAt: success(item.status) ? time + 4000 : null,
          });
        }
      }
      return next;
    });
    observed.current = new Map(snapshot.map((item) => [item.key, item.status]));
    setNow(time);
  }, [serialized]);
  const running = items.filter((item) => active(item.status));
  const visibleNotices = notices.filter(
    (notice) =>
      (notice.item.status === 'uncertain' ||
        (!notice.item.otherBranch &&
          (Date.parse(notice.item.startedAt) || 0) >= latestMainStart)) &&
      (notice.expiresAt === null || notice.expiresAt > now) &&
      !(success(notice.item.status) && hidden.includes(notice.item.key))
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
  if (!candidates.length) return null;
  const hasIssue =
    connectionIssue ||
    (item
      ? !active(item.status) && !success(item.status)
      : candidates.some((item) => !active(item.status) && !success(item.status)));
  const Icon = hasIssue ? CircleAlert : running.length ? LoaderCircle : Check;
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
  return (
    <div
      className={`activity-status ${hasIssue ? 'activity-issue' : ''}`}
      data-testid="activity-status"
    >
      <span className="sr-only" role="status" aria-live="polite">
        {label}
      </span>
      <button
        type="button"
        className="activity-toggle"
        aria-label={item ? '작업 상태 숨기기' : '작업 상태 펼치기'}
        aria-expanded={!!item}
        title={item ? '상태 표시만 숨겨요. 작업은 계속 진행돼요.' : '작업 상태 펼치기'}
        onClick={item ? hide : expand}
      >
        <Icon
          size={16}
          aria-hidden="true"
          className={running.length && !hasIssue ? 'activity-spinner' : ''}
        />
        <span className="activity-label">{label}</span>
        {elapsed && (
          <span className="activity-elapsed" aria-hidden="true">
            {elapsed}
          </span>
        )}
        {item && candidates.length > 1 && (
          <span className="activity-count">외 {candidates.length - 1}개</span>
        )}
        {item ? (
          <ChevronDown size={14} aria-hidden="true" />
        ) : (
          <ChevronUp size={14} aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        className="activity-details"
        onClick={onDetails}
        aria-label="작업 상세 보기"
      >
        상세
      </button>
    </div>
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
                kind: item.kind,
                status: item.status,
                startedAt: item.startedAt,
                finishedAt: item.finishedAt,
                otherBranch: !!branchId && !!item.branchId && item.branchId !== branchId,
              })}
            </span>
            <span className="activity-elapsed">{elapsedLabel(item.startedAt, now)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
