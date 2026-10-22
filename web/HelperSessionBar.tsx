import { t, useI18n, translateMessage, formatNumber, message as uiMessage } from './i18n.js';
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import type { HelperConversation, HelperConversationDeletion } from '../core/helper.js';
import { api, ApiError } from './api.js';
import { ActionMenu } from './ActionMenu.js';
import { Dialog } from './Dialog.js';
import { NoticeBanner } from './NoticeBanner.js';
import { LoadingState } from './LoadingState.js';
import { IconButton } from './IconButton.js';
import { CheckIcon, CloseIcon, DeleteIcon, EditIcon, StopIcon } from './ui-icons.js';
import { forgetHelperSession, type HelperSession } from './useHelperSessions.js';
import type { HelperTaskView } from './useHelperConversation.js';
import { deleteHelperSessionRecovery } from './helper-recovery.js';
import './deletion.css';

type Props = {
  sessions: HelperSession[];
  unread: string[];
  conversation: HelperConversation | null;
  currentId: string | null;
  creating: boolean;
  busy: boolean;
  onSelect: (session: HelperConversation) => void;
  onCreate: () => void;
  onUpdate: (session: HelperConversation) => void;
  onDelete: () => void;
};
export function HelperSessionBar(props: Props) {
  useI18n();
  const [rename, setRename] = useState<HelperConversation | null>(null);
  const [title, setTitle] = useState('');
  const [deleting, setDeleting] = useState<HelperConversation | null>(null);
  const [impact, setImpact] = useState<HelperConversationDeletion | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [cleanupFailure, setCleanupFailure] = useState('');
  useEffect(() => {
    if (!deleting) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const value = await api<HelperConversationDeletion>(
          `/helper/conversations/${encodeURIComponent(deleting.id)}/deletion`
        );
        if (!disposed) {
          setImpact(value);
          setReadError('');
        }
      } catch (cause) {
        if (!disposed)
          setReadError(cause instanceof Error ? cause.message : uiMessage('helpers.m168'));
      } finally {
        if (!disposed) timer = setTimeout(() => void load(), 1200);
      }
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [deleting]);
  async function stop() {
    if (!deleting || working) return;
    setWorking(true);
    setError('');
    try {
      let before: string | undefined;
      for (;;) {
        const tasks = await api<HelperTaskView[]>(
          `/helper/conversations/${encodeURIComponent(deleting.id)}/tasks${before ? `?before=${encodeURIComponent(before)}` : ''}`
        );
        for (const task of tasks.filter((item) => ['queued', 'running'].includes(item.status)))
          await api(`/helper/tasks/${encodeURIComponent(task.id)}/cancel`, {});
        if (tasks.length < 50) break;
        before = tasks.at(-1)!.id;
      }
      const value = await api<HelperConversationDeletion>(
        `/helper/conversations/${encodeURIComponent(deleting.id)}/deletion`
      ).catch((cause) => {
        setReadError(cause instanceof Error ? cause.message : uiMessage('helpers.m168'));
        return null;
      });
      if (value) {
        setImpact(value);
        setReadError('');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : uiMessage('helpers.m169'));
    } finally {
      setWorking(false);
    }
  }
  return (
    <>
      <div className="helper-session-block">
        <div className="helper-work-selector">
          <label>
            <span className="sr-only">{t('helpers.m170')}</span>
            <select
              aria-label={t('helpers.m171')}
              value={props.currentId ?? ''}
              onChange={(event) => {
                const session = props.sessions.find((item) => item.id === event.target.value);
                if (session) props.onSelect(session);
              }}
            >
              <option value="" disabled>
                {t('helpers.m172')}
              </option>
              {props.sessions.map((session) => {
                return (
                  <option key={session.id} value={session.id}>
                    {props.unread.includes(session.id) ? '● ' : ''}
                    {session.title || t('helpers.m173')}
                    {session.activity?.running
                      ? t('helpers.m174')
                      : session.activity?.queued
                        ? t('helpers.m175', { v0: formatNumber(session.activity.queued) })
                        : ''}
                  </option>
                );
              })}
            </select>
          </label>
          <IconButton
            label={t('helpers.m176')}
            icon={Plus}
            disabled={props.creating}
            onClick={props.onCreate}
          />
          <ActionMenu label={t('helpers.m177')} viewport>
            <button
              type="button"
              disabled={!props.conversation || props.busy}
              onClick={() => {
                setRename(props.conversation);
                setTitle(props.conversation?.title ?? '');
                setError('');
              }}
            >
              <EditIcon size={18} aria-hidden="true" />
              {t('helpers.m178')}
            </button>
            <button
              type="button"
              className="danger"
              disabled={!props.conversation || props.busy}
              onClick={() => {
                setDeleting(props.conversation);
                setImpact(null);
                setError('');
                setReadError('');
              }}
            >
              <DeleteIcon size={18} aria-hidden="true" />
              {t('helpers.m179')}
            </button>
          </ActionMenu>
        </div>
        {props.unread.length > 0 && (
          <div className="helper-session-meta">
            <strong>{t('helpers.m325', { count: formatNumber(props.unread.length) })}</strong>
          </div>
        )}
      </div>
      {cleanupFailure && (
        <NoticeBanner tone="error">{translateMessage(cleanupFailure)}</NoticeBanner>
      )}
      <Dialog
        open={!!rename}
        title={t('helpers.m183')}
        onClose={() => {
          if (!working) setRename(null);
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!rename || working || !title.trim()) return;
            setWorking(true);
            setError('');
            void api<HelperConversation>(
              `/helper/conversations/${encodeURIComponent(rename.id)}`,
              { expectedRevision: rename.revision, title: title.trim() },
              'PATCH'
            )
              .then((value) => {
                props.onUpdate(value);
                setRename(null);
              })
              .catch(async (cause) => {
                setError(cause.message);
                if (cause instanceof ApiError && cause.status === 409) {
                  try {
                    setRename(
                      await api<HelperConversation>(
                        `/helper/conversations/${encodeURIComponent(rename.id)}`
                      )
                    );
                  } catch {
                    /* Preserve the local name. */
                  }
                }
              })
              .finally(() => setWorking(false));
          }}
        >
          <label>
            {t('helpers.m184')}
            <input
              value={title}
              maxLength={200}
              disabled={working}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
          <div className="form-actions">
            <button
              type="button"
              className="secondary"
              disabled={working}
              onClick={() => setRename(null)}
            >
              <CloseIcon size={18} aria-hidden="true" />
              {t('helpers.m165')}
            </button>
            <button className="primary" disabled={working || !title.trim()}>
              <CheckIcon size={18} aria-hidden="true" />
              {t('helpers.m185')}
            </button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={!!deleting}
        title={t('helpers.m186')}
        variant="confirmation"
        role="alertdialog"
        className="delete-dialog"
        onClose={() => {
          if (!working) setDeleting(null);
        }}
      >
        <p>{t('helpers.m326', { title: deleting?.title || t('helpers.m173') })}</p>
        {impact ? (
          <p>{t('helpers.m327')}</p>
        ) : (
          !readError && <LoadingState presentation="inline" label={t('helpers.m188')} />
        )}
        {impact && !impact.canDelete && (
          <p role="status">
            {t('helpers.m328', {
              active: formatNumber(impact.activeTasks),
              unsettled: formatNumber(impact.unsettledAttempts),
              worker: impact.workerActive,
            })}
          </p>
        )}
        {readError && <NoticeBanner tone="error">{translateMessage(readError)}</NoticeBanner>}
        {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            disabled={working}
            onClick={() => setDeleting(null)}
          >
            <CloseIcon size={18} aria-hidden="true" />
            {t('helpers.m192')}
          </button>
          {impact && !impact.canDelete && (
            <button
              type="button"
              className="secondary"
              disabled={working || impact.activeTasks === 0}
              onClick={() => void stop()}
            >
              <StopIcon size={18} aria-hidden="true" />
              {t('helpers.m193')}
            </button>
          )}
          <button
            type="button"
            className="delete-button"
            disabled={working || !impact?.canDelete}
            onClick={() => {
              if (!deleting || !impact || working) return;
              setWorking(true);
              setError('');
              void api(
                `/helper/conversations/${encodeURIComponent(deleting.id)}`,
                impact.request,
                'DELETE'
              )
                .then(async () => {
                  forgetHelperSession(deleting);
                  try {
                    await deleteHelperSessionRecovery(deleting.id);
                  } catch {
                    setCleanupFailure(uiMessage('helpers.m194'));
                  }
                  setDeleting(null);
                  props.onDelete();
                })
                .catch((cause) => setError(cause.message))
                .finally(() => setWorking(false));
            }}
          >
            <DeleteIcon size={18} aria-hidden="true" />
            {t('helpers.m195')}
          </button>
        </div>
      </Dialog>
    </>
  );
}
