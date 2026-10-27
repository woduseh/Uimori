import { t, useI18n, translateMessage, formatNumber, message as uiMessage } from './i18n.js';
import { useEffect, useState } from 'react';
import { Plus, Settings2 } from 'lucide-react';
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
import { groupRecentDates, recentDateGroupLabel } from './recent-date-groups.js';
import './deletion.css';

type Props = {
  sessions: HelperSession[];
  expanded?: boolean;
  onSettings: () => void;
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
  const [search, setSearch] = useState('');
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
  const filteredSessions = props.sessions.filter((session) =>
    [session.title, session.chatTitle]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase())
  );
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
          {props.expanded && (
            <strong className="helper-session-title">
              {props.conversation?.title || t('helpers.m173')}
            </strong>
          )}
          <label className="helper-session-picker">
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
              {groupRecentDates(
                props.sessions.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
                (session) => session.updatedAt
              ).map((group) => (
                <optgroup key={group.key} label={recentDateGroupLabel(group)}>
                  {group.items.map((session) => (
                    <option key={session.id} value={session.id}>
                      {props.unread.includes(session.id) ? '● ' : ''}
                      {session.title || t('helpers.m173')}
                      {session.activity?.running
                        ? t('helpers.m174')
                        : session.activity?.queued
                          ? t('helpers.m175', { v0: formatNumber(session.activity.queued) })
                          : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          {props.unread.length > 0 && (
            <span
              className="helper-unread-badge"
              title={t('helpers.m325', { count: formatNumber(props.unread.length) })}
              aria-label={t('helpers.m325', { count: formatNumber(props.unread.length) })}
            >
              {formatNumber(props.unread.length)}
            </span>
          )}
          <IconButton
            label={t('helpers.m176')}
            icon={Plus}
            disabled={props.creating}
            onClick={props.onCreate}
          />
          <ActionMenu label={t('helpers.m177')} viewport>
            <div className="action-menu-group">
              <button type="button" disabled={!props.conversation} onClick={props.onSettings}>
                <Settings2 size={18} aria-hidden="true" />
                {t('helpers.m044')}
              </button>
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
            </div>
            <div className="action-menu-group">
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
            </div>
          </ActionMenu>
        </div>
        {props.expanded && (
          <nav className="helper-session-list" aria-label={t('helpers.sessions')}>
            <input
              type="search"
              aria-label={t('helpers.searchSessions')}
              placeholder={t('helpers.searchSessions')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="helper-session-list-items">
              {search && filteredSessions.length === 0 && (
                <p role="status">{t('library.noSearchResults')}</p>
              )}
              {filteredSessions.map((session) => (
                <button
                  type="button"
                  key={session.id}
                  aria-current={session.id === props.currentId ? 'true' : undefined}
                  onClick={() => props.onSelect(session)}
                >
                  <span>{session.title || t('helpers.m173')}</span>
                  {session.chatTitle && <small>{session.chatTitle}</small>}
                  {session.id === props.currentId && (
                    <CheckIcon className="helper-session-check" size={16} aria-hidden="true" />
                  )}
                  {props.unread.includes(session.id) && (
                    <span aria-label={t('helpers.m325', { count: 1 })}>●</span>
                  )}
                </button>
              ))}
            </div>
          </nav>
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
