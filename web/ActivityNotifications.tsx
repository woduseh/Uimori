import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
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
  persistenceError,
  recoveryRequestId,
  recoveryBusy,
  onRecoverRequest,
  onLater,
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
  persistenceError: boolean;
  recoveryRequestId?: string;
  recoveryBusy: boolean;
  onRecoverRequest: (requestId: string) => void;
  onLater: (item: ActivityNoticeItem) => void;
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
      {persistenceError && (
        <NoticeBanner tone="error">
          확인 기록을 브라우저에 저장하지 못했어요. 이 화면에서는 숨겨지지만 앱을 다시 열면 알림이
          나타날 수 있어요.
        </NoticeBanner>
      )}
      <ul className="activity-notification-items">
        {visible.map((item) => {
          const confirmed = acknowledged.includes(item.acknowledgementKey);
          const recoverable =
            item.kind === 'request' &&
            item.status === 'uncertain' &&
            item.runId === recoveryRequestId;
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
                    · {item.kind === 'request' ? '장면 생성' : `작업 ${item.runId.slice(0, 8)}`}
                  </small>
                </div>
                <div className="activity-notification-actions">
                  {item.kind !== 'request' && (
                    <button
                      type="button"
                      className="secondary"
                      aria-expanded={inspected === item.acknowledgementKey}
                      onClick={() =>
                        setInspected(
                          inspected === item.acknowledgementKey ? null : item.acknowledgementKey
                        )
                      }
                    >
                      상세
                    </button>
                  )}
                  {item.kind === 'request' && item.status === 'uncertain' ? (
                    <>
                      <button type="button" className="secondary" onClick={() => onLater(item)}>
                        나중에
                      </button>
                      {recoverable && (
                        <button
                          type="button"
                          disabled={recoveryBusy}
                          aria-busy={recoveryBusy}
                          onClick={() => onRecoverRequest(item.runId)}
                        >
                          {recoveryBusy ? '확인 중…' : '접수 확인'}
                        </button>
                      )}
                    </>
                  ) : (
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
                  )}
                </div>
              </div>
              {item.kind === 'request' && item.status === 'uncertain' ? (
                <small>
                  {recoverable
                    ? '서버 응답을 받지 못했어요. 같은 요청으로 다시 확인하며, 아직 접수되지 않았다면 생성을 시작할 수 있어요. 이미 접수된 요청은 중복 생성하지 않아요.'
                    : '이 탭에 복구 가능한 요청 정보가 없어요. 알림을 잠시 숨기거나 작업 기록을 확인할 수 있어요.'}
                </small>
              ) : item.executionUncertain && canAcknowledge(item) ? (
                <small>
                  실행 결과가 불확실해요. 확인은 알림만 정리하며 작업 기록과 상태는 유지돼요.
                </small>
              ) : !canAcknowledge(item) ? (
                <small>진행 중인 작업은 아직 확인할 수 없어요.</small>
              ) : null}
              {inspected === item.acknowledgementKey && (
                <NotificationDetail
                  key={item.acknowledgementKey}
                  chatId={chatId}
                  item={item}
                  onRead={() => onAcknowledge([item])}
                />
              )}
            </li>
          );
        })}
      </ul>
      {!visible.length && !loading && !error && <p role="status">확인할 알림이 없어요.</p>}
      {loading && !error && <LoadingState compact label="이전 작업을 불러오는 중이에요…" />}
      {error && (
        <NoticeBanner
          tone="error"
          actions={
            <button
              type="button"
              className="secondary"
              onClick={() => void load(cursor ?? undefined)}
            >
              다시 불러오기
            </button>
          }
        >
          {error}
        </NoticeBanner>
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

function NotificationDetail({
  chatId,
  item,
  onRead,
}: {
  chatId: string;
  item: ActivityNoticeItem;
  onRead: () => void;
}) {
  const [result, setResult] = useState<{ status: string; error?: string | null } | null>(null);
  const [error, setError] = useState('');
  const read = useRef(onRead);
  read.current = onRead;
  const { kind, runId, generation } = item;
  useEffect(() => {
    let current = true;
    const collection = kind === 'main' ? 'runs' : kind === 'state' ? 'story-jobs' : 'jobs';
    const path =
      kind === 'extension'
        ? `/chats/${encodeURIComponent(chatId)}/extension-operations/${encodeURIComponent(runId)}`
        : `/${collection}/${encodeURIComponent(runId)}`;
    void api<{ status: string; error?: string | null; attempt?: number; generation?: number }>(path)
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
  }, [chatId, kind, runId, generation]);
  if (error || !result)
    return (
      <LoadingState compact loading={!error} error={error} label="상세를 불러오는 중이에요…" />
    );
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
