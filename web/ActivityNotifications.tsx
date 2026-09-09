import { useEffect, useRef, useState } from 'react';
import type { ReaderActivity } from '../core/types.js';
import { Dialog } from './Dialog.js';
import { ApiError, api, labels } from './api.js';
import { auxiliaryErrorDiagnostic } from './auxiliary-error.js';
import { canAcknowledge, type ActivityNoticeItem } from './activity-notices.js';

type ActivityPage = { items: ReaderActivity[]; nextCursor: string | null };

export function ActivityNotifications({
  open,
  chatId,
  items,
  acknowledged,
  message,
  onAcknowledge,
  onHistory,
  onClose,
  onRecords,
}: {
  open: boolean;
  chatId: string;
  items: ActivityNoticeItem[];
  acknowledged: string[];
  message: (item: ActivityNoticeItem) => string;
  onAcknowledge: (items: ActivityNoticeItem[]) => void;
  onHistory: (items: ReaderActivity[]) => void;
  onClose: () => void;
  onRecords: () => void;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [inspected, setInspected] = useState<string | null>(null);
  const sequence = useRef(0);
  const history = useRef(onHistory);
  history.current = onHistory;
  async function load(before?: string) {
    const version = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const page = await api<ActivityPage>(
        `/chats/${encodeURIComponent(chatId)}/activities?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`
      );
      if (version !== sequence.current) return;
      history.current(page.items);
      setCursor(page.nextCursor);
    } catch {
      if (version === sequence.current)
        setError('이전 작업을 불러오지 못했어요. 표시된 알림은 확인할 수 있어요.');
    } finally {
      if (version === sequence.current) setLoading(false);
    }
  }
  // Each opening starts a fresh history read. Late reads cannot affect another chat or opening.
  // biome-ignore lint/correctness/useExhaustiveDependencies: load is scoped by chatId and guarded by sequence.
  useEffect(() => {
    if (open) {
      setCursor(null);
      setInspected(null);
      void load();
    }
    return () => {
      sequence.current++;
    };
  }, [open, chatId]);
  const visible = items.filter(
    (item) =>
      !acknowledged.includes(item.acknowledgementKey) || inspected === item.acknowledgementKey
  );
  const confirmable = visible.filter(
    (item) => canAcknowledge(item) && !acknowledged.includes(item.acknowledgementKey)
  );
  return (
    <Dialog open={open} title="작업 알림" onClose={onClose} className="activity-notifications">
      <div className="activity-notification-toolbar">
        <p>확인하면 알림만 사라지고 작업 기록은 보존돼요.</p>
        <button
          type="button"
          className="secondary"
          disabled={!confirmable.length}
          onClick={() => {
            onAcknowledge(confirmable);
            setInspected(null);
          }}
        >
          모두 확인
        </button>
      </div>
      <ul className="activity-notification-items">
        {visible.map((item) => {
          const confirmed = acknowledged.includes(item.acknowledgementKey);
          return (
            <li
              key={item.acknowledgementKey}
              data-testid="activity-notice"
              data-activity-id={item.runId}
            >
              <div className="activity-notification-heading">
                <div>
                  <strong>{message(item)}</strong>
                  <small>
                    <time dateTime={item.startedAt}>
                      {new Date(item.startedAt).toLocaleString()}
                    </time>{' '}
                    · {item.runId}
                  </small>
                </div>
                <div className="activity-notification-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={item.kind === 'request'}
                    aria-expanded={inspected === item.acknowledgementKey}
                    onClick={() =>
                      setInspected(
                        inspected === item.acknowledgementKey ? null : item.acknowledgementKey
                      )
                    }
                  >
                    상세
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={confirmed || !canAcknowledge(item)}
                    onClick={() => {
                      onAcknowledge([item]);
                      if (inspected === item.acknowledgementKey) setInspected(null);
                    }}
                  >
                    {confirmed ? '확인됨' : '확인'}
                  </button>
                </div>
              </div>
              {!canAcknowledge(item) && (
                <small>진행 중이거나 실행 여부 확인이 필요한 작업은 알림을 유지해요.</small>
              )}
              {inspected === item.acknowledgementKey && (
                <NotificationDetail
                  key={item.acknowledgementKey}
                  item={item}
                  onRead={() => onAcknowledge([item])}
                />
              )}
            </li>
          );
        })}
      </ul>
      {!visible.length && <p role="status">확인할 알림이 없어요.</p>}
      {loading && <p role="status">이전 작업을 불러오는 중이에요…</p>}
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => void load(cursor ?? undefined)}>
            다시 불러오기
          </button>
        </p>
      )}
      {cursor && !error && (
        <button
          type="button"
          className="secondary"
          disabled={loading}
          onClick={() => void load(cursor)}
        >
          이전 작업 더 보기
        </button>
      )}
      <button type="button" className="secondary" onClick={onRecords}>
        전체 작업 기록
      </button>
    </Dialog>
  );
}

function NotificationDetail({ item, onRead }: { item: ActivityNoticeItem; onRead: () => void }) {
  const [result, setResult] = useState<{ status: string; error?: string | null } | null>(null);
  const [error, setError] = useState('');
  const read = useRef(onRead);
  read.current = onRead;
  const { kind, runId, generation } = item;
  useEffect(() => {
    let current = true;
    const collection = kind === 'main' ? 'runs' : kind === 'state' ? 'story-jobs' : 'jobs';
    void api<{ status: string; error?: string | null; attempt?: number; generation?: number }>(
      `/${collection}/${encodeURIComponent(runId)}`
    )
      .then((value) => {
        if (!current) return;
        const actualGeneration = value.generation ?? value.attempt;
        if (
          generation !== undefined &&
          actualGeneration !== undefined &&
          generation !== actualGeneration
        ) {
          setError(
            '새 실행으로 바뀌어 이 알림의 상세를 불러올 수 없어요. 확인 버튼으로 알림을 정리할 수 있어요.'
          );
          return;
        }
        setResult(value);
        read.current();
      })
      .catch((cause) => {
        if (current)
          setError(
            `상세를 불러오지 못했어요${cause instanceof ApiError ? ` (${cause.status})` : ''}. 확인 버튼으로 알림을 정리할 수 있어요.`
          );
      });
    return () => {
      current = false;
    };
  }, [kind, runId, generation]);
  if (error) return <p role="alert">{error}</p>;
  if (!result) return <p role="status">상세를 불러오는 중이에요…</p>;
  const diagnostic = result.error ? auxiliaryErrorDiagnostic(result.error) : null;
  return (
    <div className="activity-notification-detail">
      <p>상태: {labels[result.status] ?? '확인 필요'}</p>
      {diagnostic && (
        <>
          <p>{diagnostic.message}</p>
          <p>{diagnostic.action}</p>
          {diagnostic.code && <small>오류 코드: {diagnostic.code}</small>}
        </>
      )}
    </div>
  );
}
