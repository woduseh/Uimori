import { t, useI18n, translateMessage, formatNumber } from './i18n.js';
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
  translationResolved,
  type ActivityNoticeItem as Item,
} from './activity-notices.js';
import {
  readAcknowledgements,
  saveAcknowledgements,
  migrateAcknowledgements,
  isAcknowledgementStorageKey,
} from './activity-acknowledgements.js';
import { api } from './api.js';
import { activityReceiptEvent } from './useActivityFeed.js';
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
  main: 'helpers.m212',
  translation: 'helpers.m213',
  image: 'helpers.m214',
  illustration: 'helpers.m215',
};
const doneNames: Record<string, string> = {
  main: 'helpers.m216',
  translation: 'helpers.m217',
  image: 'helpers.m218',
  status: 'helpers.m219',
  illustration: 'helpers.m220',
  request: 'helpers.m221',
};
export function elapsedLabel(start: string, end: number) {
  const timestamp = Date.parse(start);
  if (!Number.isFinite(timestamp) || !Number.isFinite(end)) return '';
  const seconds = Math.max(0, Math.floor((end - timestamp) / 1000));
  return seconds < 60
    ? t('helpers.m222', { v0: seconds })
    : t('helpers.m223', { v0: Math.floor(seconds / 60), v1: seconds % 60 });
}
export function activityStatusLabel(item: Pick<Item, 'kind' | 'status'>) {
  const name = t(doneNames[item.kind] ?? 'helpers.m224');
  const status =
    item.status === 'sending'
      ? t('helpers.m225')
      : item.status === 'accepted'
        ? t('helpers.m226')
        : item.status === 'uncertain'
          ? t('helpers.m227')
          : item.status === 'queued'
            ? t('helpers.m228', { v0: name })
            : item.status === 'running'
              ? t(names[item.kind] ?? 'helpers.m229')
              : item.status === 'completed'
                ? t('helpers.m230', { v0: name })
                : item.status === 'cancelled'
                  ? t('helpers.m231', { v0: name })
                  : item.status === 'refused'
                    ? t('helpers.m232', { v0: name })
                    : item.status === 'interrupted'
                      ? t('helpers.m233', { v0: name })
                      : item.status === 'partial'
                        ? t('helpers.m234', { v0: name })
                        : item.status === 'stale'
                          ? t('helpers.m235', { v0: name })
                          : t('helpers.m236', { v0: name });
  return status;
}

/** Status feedback only; hiding never changes or cancels server work. */
export function ActivityStatus({
  chatId,
  activities,
  request,
  connected,
  onDetails,
  recoveryRequestId,
  recoveryBusy = false,
  recoveryError = '',
  onRecoverRequest,
  scope,
  seenRunIds = [],
}: {
  chatId: string;
  activities: ReaderActivity[];
  request?: RequestActivity;
  connected: boolean;
  onDetails: () => void;
  recoveryRequestId?: string;
  recoveryBusy?: boolean;
  recoveryError?: string;
  onRecoverRequest: (requestId: string) => void;
  scope: string;
  /** Pending turns whose failure card the reader has scrolled into view. */
  seenRunIds?: string[];
}) {
  useI18n();
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
  const [persistenceError, setPersistenceError] = useState(false);
  useEffect(() => {
    setPersistenceError(!migrateAcknowledgements(chatId));
    const sync = (event: StorageEvent) => {
      if (!isAcknowledgementStorageKey(chatId, event.key)) return;
      const saved = readAcknowledgements(chatId);
      setAcknowledged((old) => [...new Set([...old, ...saved])]);
    };
    let alive = true;
    const local = readAcknowledgements(chatId);
    void api<{ keys: string[] }>(`/chats/${encodeURIComponent(chatId)}/activity-acknowledgements`)
      .then(async ({ keys }) => {
        if (!alive) return;
        setAcknowledged((old) => [...new Set([...old, ...keys])]);
        const missing = local.filter((key) => !keys.includes(key));
        for (let i = 0; i < missing.length; i += 100) {
          await api(`/chats/${encodeURIComponent(chatId)}/activity-acknowledgements`, {
            keys: missing.slice(i, i + 100),
          });
        }
      })
      .catch(() => {
        /* Browser-local confirmations still work offline. */
      });
    const receipt = (event: Event) => {
      const detail = (event as CustomEvent<{ chatId: string; keys: string[] }>).detail;
      if (detail?.chatId === chatId)
        setAcknowledged((old) => [...new Set([...old, ...detail.keys])]);
    };
    window.addEventListener(activityReceiptEvent, receipt);
    window.addEventListener('storage', sync);
    return () => {
      alive = false;
      window.removeEventListener('storage', sync);
      window.removeEventListener(activityReceiptEvent, receipt);
    };
  }, [chatId]);
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
  const items: Item[] = [...merged.values()]
    .filter((item) => item.kind !== 'status')
    .map((item) => ({
      key: request?.runId === item.id ? request.id : `${item.id}:${item.startedAt}`,
      acknowledgementKey: activityAcknowledgementKey(item),
      status: item.status,
      startedAt: request?.runId === item.id ? request.startedAt : item.startedAt,
      finishedAt: item.finishedAt,
      kind: item.kind,
      runId: item.id,
      sourceRevision: item.sourceRevision,
      sourceHash: item.sourceHash,
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
      runId: request.runId ?? request.id,
    });
  const serialized = JSON.stringify(items);
  const resolved = items.filter((item) => translationResolved(item, items));
  const resolvedKeys = JSON.stringify(resolved.map((item) => item.acknowledgementKey));
  useEffect(() => {
    const keys = JSON.parse(resolvedKeys) as string[];
    if (keys.length) {
      const saved = saveAcknowledgements(chatId, keys);
      if (!saved) setPersistenceError(true);
      setAcknowledged((old) => [...new Set([...old, ...keys])]);
    }
  }, [resolvedKeys, chatId]);
  // An older settled result belongs to its response. Keep active work and uncertain
  // admission visible, but do not let old failures replace the current turn's result.
  const latestMainStart = items
    .filter((item) => ['main', 'request'].includes(item.kind))
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
  // A retry replaces the execution it retried. Its notice carries the older generation in its
  // acknowledgement key, so the reconciling effect above only drops it after the next paint.
  // Filtering here keeps one activity from showing two contradictory rows in between.
  const retried = (notice: Notice) =>
    items.some(
      (item) =>
        item.runId === notice.item.runId &&
        item.generation !== undefined &&
        notice.item.generation !== undefined &&
        item.generation > notice.item.generation
    );
  const unresolvedNotices = notices.filter(
    (notice) =>
      (notice.expiresAt === null || notice.expiresAt > now) &&
      !resolved.some((item) => item.acknowledgementKey === notice.item.acknowledgementKey) &&
      !retried(notice)
  );
  const visibleNotices = unresolvedNotices.filter(
    (notice) =>
      (notice.item.status === 'uncertain' ||
        (Date.parse(notice.item.startedAt) || 0) >= latestMainStart) &&
      (notice.expiresAt === null || notice.expiresAt > now) &&
      !acknowledged.includes(notice.item.acknowledgementKey) &&
      // Postponing this warning does not change the recoverable request.
      !(
        notice.item.kind === 'request' &&
        notice.item.status === 'uncertain' &&
        hidden.includes(notice.item.key)
      ) &&
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
    expanded.find((item) => active(item.status) && ['main', 'request'].includes(item.kind)) ??
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
    ? t('helpers.m237')
    : item
      ? activityStatusLabel(item)
      : hasIssue
        ? t('helpers.m115')
        : t('helpers.m238', { v0: formatNumber(running.length) });
  const measured =
    item && !connectionIssue
      ? elapsedLabel(item.startedAt, active(item.status) ? now : Date.parse(item.finishedAt ?? ''))
      : '';
  // A finished task that took under a second has no meaningful duration to show.
  const elapsed =
    item &&
    !active(item.status) &&
    Date.parse(item.finishedAt ?? '') - Date.parse(item.startedAt) < 1000
      ? ''
      : measured;
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
    // Persist this exact displayed execution before hiding it; never save a stale whole-tab snapshot.
    const saved = saveAcknowledgements(chatId, [...acknowledged, ...keys]);
    if (keys.length)
      void api(`/chats/${encodeURIComponent(chatId)}/activity-acknowledgements`, { keys })
        .then(() =>
          window.dispatchEvent(new CustomEvent(activityReceiptEvent, { detail: { chatId, keys } }))
        )
        .catch(() => setPersistenceError(true));
    setPersistenceError(!saved);
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
            issueSelected ? t('helpers.m239') : item ? t('helpers.m098') : t('helpers.m099')
          }
          toggleTitle={
            issueSelected ? t('helpers.m240') : item ? t('helpers.m241') : t('helpers.m099')
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
        persistenceError={persistenceError}
        recoveryRequestId={recoveryRequestId}
        recoveryBusy={recoveryBusy}
        recoveryError={translateMessage(recoveryError)}
        onRecoverRequest={onRecoverRequest}
        onLater={(notice) => {
          if (notice.kind !== 'request' || notice.status !== 'uncertain') return;
          setHidden((old) => [...new Set([...old, notice.key])]);
          setNotificationsOpen(false);
        }}
        message={activityStatusLabel}
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

export function ActivityDetails({ activities }: { activities: ReaderActivity[] }) {
  useI18n();
  const [now, setNow] = useState(Date.now);
  const running = activities.filter((item) => item.kind !== 'status' && active(item.status));
  useEffect(() => {
    if (!running.length) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running.length]);
  if (!running.length) return null;
  return (
    <section className="activity-list" aria-label={t('helpers.m242')}>
      <h3>{t('helpers.m330', { count: formatNumber(running.length) })}</h3>
      <ul>
        {running.map((item) => (
          <li key={item.id}>
            <span>{activityStatusLabel(item)}</span>
            <span className="activity-elapsed">{elapsedLabel(item.startedAt, now)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
