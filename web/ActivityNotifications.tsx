import { t, useI18n, translateMessage, formatDate, message as uiMessage } from './i18n.js';
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
  recoveryError,
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
  recoveryError: string;
  onRecoverRequest: (requestId: string) => void;
  onLater: (item: ActivityNoticeItem) => void;
  message: (item: ActivityNoticeItem) => string;
  onAcknowledge: (items: ActivityNoticeItem[]) => void;
  onHistory: (items: ReaderActivity[]) => void;
  onClose: () => void;
  onRecords: () => void;
}) {
  useI18n();
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
      if (version === sequence.current) setError(uiMessage('helpers.m283'));
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
    <Dialog
      open={open}
      title={t('helpers.m284')}
      onClose={onClose}
      className="activity-notifications"
    >
      <div className="activity-notification-toolbar">
        <p>{t('helpers.m285')}</p>
        <button
          type="button"
          className="secondary"
          disabled={!confirmable.length}
          onClick={() => {
            onAcknowledge(confirmable);
            setInspected(null);
          }}
        >
          {t('helpers.m286')}
        </button>
      </div>
      {persistenceError && <NoticeBanner tone="error">{t('helpers.m287')}</NoticeBanner>}
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
                  <small className="ui-meta-row">
                    <time dateTime={item.startedAt}>
                      {formatDate(new Date(item.startedAt), {
                        dateStyle: 'medium',
                        timeStyle: 'medium',
                      })}
                    </time>
                    <span>
                      {item.kind === 'request'
                        ? t('helpers.m288')
                        : t('helpers.m238', { v0: item.runId.slice(0, 8) })}
                    </span>
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
                      {t('helpers.m246')}
                    </button>
                  )}
                  {item.kind === 'request' && item.status === 'uncertain' ? (
                    <>
                      <button type="button" className="secondary" onClick={() => onLater(item)}>
                        {t('helpers.m289')}
                      </button>
                      {recoverable && (
                        <button
                          type="button"
                          disabled={recoveryBusy}
                          aria-busy={recoveryBusy}
                          onClick={() => onRecoverRequest(item.runId)}
                        >
                          {recoveryBusy ? t('helpers.m290') : t('helpers.m291')}
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
                      {confirmed ? t('helpers.m292') : t('helpers.m267')}
                    </button>
                  )}
                </div>
              </div>
              {item.kind === 'request' && item.status === 'uncertain' ? (
                <small>{recoverable ? t('helpers.m293') : t('helpers.m294')}</small>
              ) : item.executionUncertain && canAcknowledge(item) ? (
                <small>{t('helpers.m295')}</small>
              ) : !canAcknowledge(item) ? (
                <small>{t('helpers.m296')}</small>
              ) : null}
              {recoverable && recoveryError && (
                <NoticeBanner tone="error">{translateMessage(recoveryError)}</NoticeBanner>
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
      {!visible.length && !loading && !error && <p role="status">{t('helpers.m297')}</p>}
      {loading && !error && <LoadingState presentation="inline" label={t('helpers.m298')} />}
      {error && (
        <NoticeBanner
          tone="error"
          actions={
            <button
              type="button"
              className="secondary"
              onClick={() => void load(cursor ?? undefined)}
            >
              {t('helpers.m137')}
            </button>
          }
        >
          {translateMessage(error)}
        </NoticeBanner>
      )}
      {cursor && !error && (
        <button
          type="button"
          className="secondary"
          disabled={loading}
          onClick={() => void load(cursor)}
        >
          {t('helpers.m072')}
        </button>
      )}
      <button type="button" className="secondary" onClick={onRecords}>
        {t('helpers.m299')}
      </button>
    </Dialog>
  );
}

function NotificationDetail({ item, onRead }: { item: ActivityNoticeItem; onRead: () => void }) {
  useI18n();
  const [result, setResult] = useState<{ status: string; error?: string | null } | null>(null);
  const [error, setError] = useState('');
  const read = useRef(onRead);
  read.current = onRead;
  const { kind, runId, generation } = item;
  useEffect(() => {
    let current = true;
    const collection =
      kind === 'main' ? 'runs' : kind === 'illustration' ? 'illustrations' : 'jobs';
    const path = `/${collection}/${encodeURIComponent(runId)}`;
    void api<{ status: string; error?: string | null; attempt?: number; generation?: number }>(path)
      .then((value) => {
        if (!current) return;
        const actualGeneration = value.generation ?? value.attempt;
        if (
          generation !== undefined &&
          actualGeneration !== undefined &&
          generation !== actualGeneration
        ) {
          setError(uiMessage('helpers.m300'));
          return;
        }
        setResult(value);
        read.current();
      })
      .catch((cause) => {
        if (current)
          setError(
            uiMessage('helpers.m301', { v0: cause instanceof ApiError ? ` (${cause.status})` : '' })
          );
      });
    return () => {
      current = false;
    };
  }, [kind, runId, generation]);
  if (error || !result)
    return (
      <LoadingState
        presentation="inline"
        loading={!error}
        error={translateMessage(error)}
        label={t('helpers.m302')}
      />
    );
  const diagnostic = result.error ? auxiliaryErrorDiagnostic(result.error) : null;
  return (
    <div className="activity-notification-detail">
      <p>{t('helpers.m333', { status: labels[result.status] ?? t('helpers.m115') })}</p>
      {diagnostic && (
        <>
          <p>{translateMessage(diagnostic.message)}</p>
          <p>{translateMessage(diagnostic.action)}</p>
          {diagnostic.code && <small>{t('helpers.m334', { code: diagnostic.code })}</small>}
        </>
      )}
    </div>
  );
}
