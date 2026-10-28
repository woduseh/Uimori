import { t, useI18n, translateMessage, formatNumber, message as uiMessage } from './i18n.js';
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import { Plus, FolderPlus, Settings2, Copy, ChevronDown, ChevronRight } from 'lucide-react';
import type {
  HelperConversation,
  HelperConversationDeletion,
  HelperProject,
} from '../core/helper.js';
import { activityChangedEvent, api, ApiError } from './api.js';
import { ActionMenu } from './ActionMenu.js';
import { Dialog } from './Dialog.js';
import { NoticeBanner } from './NoticeBanner.js';
import { LoadingState } from './LoadingState.js';
import { IconButton } from './IconButton.js';
import { SaveButton } from './SaveButton.js';
import { CheckIcon, CloseIcon, DeleteIcon, EditIcon, StopIcon } from './ui-icons.js';
import { forgetHelperSession, type HelperSession } from './useHelperSessions.js';
import type { HelperTaskView } from './useHelperConversation.js';
import { deleteHelperSessionRecovery } from './helper-recovery.js';
import { groupRecentDates, recentDateGroupLabel } from './recent-date-groups.js';
import { pendingHelperRequest, clearPendingHelperRequest } from './helper-pending-request.js';
import './deletion.css';
import './helper-session-navigation.css';

type Props = {
  sessions: HelperSession[];
  expanded?: boolean;
  open?: boolean;
  onSettings: () => void;
  unread: string[];
  conversation: HelperConversation | null;
  currentId: string | null;
  creating: boolean;
  busy: boolean;
  onSelect: (session: HelperConversation) => void;
  onCreate: () => void;
  onUpdate: (session: HelperConversation) => void;
  onDelete: (id: string) => void;
  onClone?: (session: HelperConversation) => void;
  navigationHost?: HTMLElement | null;
  navigationActions?: MutableRefObject<{ create: () => void } | null>;
  searchRequest?: number;
  onProjectsChanged?: () => void;
};
export function HelperSessionBar(props: Props) {
  useI18n();
  const [search, setSearch] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const handledSearchRequest = useRef(0);
  const projectHeadings = useRef(new Map<string, HTMLButtonElement>());
  const [focusProject, setFocusProject] = useState<string | null>(null);
  useEffect(() => {
    if (!props.navigationActions) return;
    props.navigationActions.current = {
      create: () => {
        if (!props.creating) props.onCreate();
      },
    };
    return () => {
      if (props.navigationActions) props.navigationActions.current = null;
    };
  }, [props.navigationActions, props.onCreate, props.creating]);
  useEffect(() => {
    if (
      !props.navigationHost ||
      !props.searchRequest ||
      handledSearchRequest.current === props.searchRequest
    )
      return;
    handledSearchRequest.current = props.searchRequest;
    const frame = requestAnimationFrame(() => searchInput.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [props.navigationHost, props.searchRequest]);
  const [recentCount, setRecentCount] = useState(5);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [copying, setCopying] = useState<string | null>(null);
  const [copyError, setCopyError] = useState('');
  const [projects, setProjects] = useState<HelperProject[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const projectReadVersion = useRef(0);
  const [projectEditor, setProjectEditor] = useState<HelperProject | 'new' | null>(null);
  useEffect(() => {
    if (!focusProject || projectEditor) return;
    const heading = projectHeadings.current.get(focusProject);
    if (!heading) return;
    const frame = requestAnimationFrame(() => {
      heading.scrollIntoView({ block: 'nearest' });
      heading.focus();
      setFocusProject(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusProject, projectEditor]);
  const [projectTitle, setProjectTitle] = useState('');
  const [projectDeleting, setProjectDeleting] = useState<HelperProject | null>(null);
  const [moving, setMoving] = useState<HelperSession | null>(null);
  const [moveProject, setMoveProject] = useState('');
  const [projectError, setProjectError] = useState('');
  const [projectWorking, setProjectWorking] = useState(false);
  const [rename, setRename] = useState<HelperConversation | null>(null);
  const [title, setTitle] = useState('');
  const [deleting, setDeleting] = useState<HelperConversation | null>(null);
  const [impact, setImpact] = useState<HelperConversationDeletion | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [cleanupFailure, setCleanupFailure] = useState('');
  const reloadProjects = useCallback(async () => {
    const version = ++projectReadVersion.current;
    try {
      const values = await api<HelperProject[]>('/helper/projects');
      if (version !== projectReadVersion.current) return;
      setProjects(values);
      setProjectsLoaded(true);
      setProjectError('');
    } catch (cause) {
      if (version !== projectReadVersion.current) return;
      setProjectsLoaded(false);
      setProjectError(
        cause instanceof Error ? cause.message : uiMessage('helperNavigation.loadFailed')
      );
    }
  }, []);
  const projectChanged = () =>
    window.dispatchEvent(new CustomEvent(activityChangedEvent, { detail: '/helper/projects' }));
  useEffect(() => {
    if (props.open === false) return;
    const refresh = () => {
      if (!document.hidden) void reloadProjects();
    };
    const submitted = (event: Event) => {
      const path = (event as CustomEvent<string>).detail;
      if (typeof path === 'string' && path.startsWith('/helper/projects')) refresh();
    };
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener(activityChangedEvent, submitted);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener(activityChangedEvent, submitted);
      projectReadVersion.current++;
    };
  }, [props.open, reloadProjects]);
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
    [
      session.title,
      session.chatTitle,
      projects.find((project) => project.id === session.projectId)?.title,
    ]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase())
  );
  const recent = filteredSessions.toSorted((a, b) =>
    (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
  );
  const startRename = (session: HelperConversation) => {
    setRename(session);
    setTitle(session.title ?? '');
    setError('');
  };
  const startDelete = (session: HelperConversation) => {
    setDeleting(session);
    setImpact(null);
    setError('');
    setReadError('');
  };
  const copySession = async (session: HelperSession) => {
    if (copying) return;
    setCopying(session.id);
    setCopyError('');
    const storageKey = `uimori:helper-copy:${session.id}`;
    const input = {
      expectedRevision: session.revision,
      expectedEventSequence: session.latestEventSeq ?? 0,
    };
    type CopyRequest = typeof input & { requestKey: string };
    let pending: { request: CopyRequest; storage: Storage } | undefined;
    try {
      pending = pendingHelperRequest(
        storageKey,
        () => ({ ...input, requestKey: crypto.randomUUID() }),
        (value): value is CopyRequest => {
          if (!value || typeof value !== 'object') return false;
          const item = value as Partial<CopyRequest>;
          return (
            typeof item.requestKey === 'string' &&
            item.requestKey.length > 0 &&
            typeof item.expectedRevision === 'number' &&
            typeof item.expectedEventSequence === 'number'
          );
        }
      );
      const value = await api<HelperConversation>(
        `/helper/conversations/${encodeURIComponent(session.id)}/copy`,
        pending.request
      );
      clearPendingHelperRequest(storageKey, pending);
      props.onClone?.(value);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status < 500 && ![408, 429].includes(cause.status)) {
        clearPendingHelperRequest(storageKey, pending);
      }
      setCopyError(
        cause instanceof Error ? cause.message : uiMessage('helperNavigation.copyFailed')
      );
    } finally {
      setCopying(null);
    }
  };
  const row = (session: HelperSession) => (
    <div className="helper-nav-row" key={session.id} data-conversation-id={session.id}>
      <button
        type="button"
        className="helper-nav-select"
        aria-current={session.id === props.currentId ? 'true' : undefined}
        onClick={() => props.onSelect(session)}
      >
        <span>{session.title || t('helpers.m173')}</span>
        {session.activity?.running || session.activity?.queued ? (
          <small>
            {session.activity.running
              ? t('helpers.m113')
              : t('helpers.queuedCount', { count: formatNumber(session.activity.queued) })}
          </small>
        ) : null}
        {props.unread.includes(session.id) && (
          <span aria-label={t('helpers.m325', { count: 1 })}>●</span>
        )}
        {session.id === props.currentId && <CheckIcon size={16} aria-hidden="true" />}
      </button>
      <ActionMenu
        label={t('helperNavigation.actions', { title: session.title || t('helpers.m173') })}
        viewport
      >
        <div className="action-menu-group">
          <button type="button" onClick={() => startRename(session)}>
            <EditIcon size={18} aria-hidden="true" />
            {t('helpers.m178')}
          </button>
          <button type="button" disabled={!!copying} onClick={() => void copySession(session)}>
            <Copy size={18} aria-hidden="true" />
            {t('helperNavigation.copy')}
          </button>
          <button
            type="button"
            onClick={() => {
              setMoving(session);
              setMoveProject(session.projectId ?? '');
              setProjectError('');
            }}
          >
            {t('helperNavigation.move')}
          </button>
        </div>
        <div className="action-menu-group">
          <button type="button" className="danger" onClick={() => startDelete(session)}>
            <DeleteIcon size={18} aria-hidden="true" />
            {t('helpers.m179')}
          </button>
        </div>
      </ActionMenu>
    </div>
  );
  const navigation = (
    <nav className="helper-navigation" aria-label={t('helpers.sessions')}>
      <div className="helper-navigation-tools">
        <input
          ref={searchInput}
          type="search"
          aria-label={t('helpers.searchSessions')}
          placeholder={t('helpers.searchSessions')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <IconButton
          label={t('helperNavigation.newProject')}
          icon={FolderPlus}
          onClick={() => {
            setProjectEditor('new');
            setProjectTitle('');
            setProjectError('');
          }}
        />
      </div>
      {projectError && !projectEditor && !projectDeleting && !moving && (
        <NoticeBanner tone="error">
          {translateMessage(projectError)}{' '}
          <button type="button" onClick={() => void reloadProjects()}>
            {t('helperNavigation.retry')}
          </button>
        </NoticeBanner>
      )}
      {copyError && <NoticeBanner tone="error">{translateMessage(copyError)}</NoticeBanner>}
      <div className="helper-navigation-scroll">
        {search && filteredSessions.length === 0 && (
          <p role="status">{t('library.noSearchResults')}</p>
        )}
        {!search.trim() &&
          projects.map((project) => (
            <section key={project.id} className="helper-nav-group" aria-label={project.title}>
              <div className="helper-nav-project-heading">
                <button
                  ref={(node) => {
                    if (node) projectHeadings.current.set(project.id, node);
                    else projectHeadings.current.delete(project.id);
                  }}
                  type="button"
                  className="helper-nav-heading"
                  aria-expanded={!collapsed[project.id]}
                  onClick={() =>
                    setCollapsed((old) => ({ ...old, [project.id]: !old[project.id] }))
                  }
                >
                  {collapsed[project.id] ? (
                    <ChevronRight size={16} aria-hidden="true" />
                  ) : (
                    <ChevronDown size={16} aria-hidden="true" />
                  )}
                  <span>{project.title}</span>
                </button>
                <ActionMenu
                  label={t('helperNavigation.projectActions', { title: project.title })}
                  viewport
                >
                  <div className="action-menu-group">
                    <button
                      type="button"
                      onClick={() => {
                        setProjectEditor(project);
                        setProjectTitle(project.title);
                        setProjectError('');
                      }}
                    >
                      <EditIcon size={18} aria-hidden="true" />
                      {t('helperNavigation.renameProject')}
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        setProjectDeleting(project);
                        setProjectError('');
                      }}
                    >
                      <DeleteIcon size={18} aria-hidden="true" />
                      {t('helperNavigation.deleteProject')}
                    </button>
                  </div>
                </ActionMenu>
              </div>
              {!collapsed[project.id] &&
                recent.filter((session) => session.projectId === project.id).map(row)}
            </section>
          ))}
        {recent.length > 0 && (
          <section
            className="helper-nav-group"
            aria-label={search.trim() ? t('helpers.searchSessions') : t('helperNavigation.recent')}
          >
            {!search.trim() && <h3>{t('helperNavigation.recent')}</h3>}
            {(search.trim() ? recent : recent.slice(0, recentCount)).map(row)}
            {!search.trim() && recent.length > recentCount && (
              <button
                type="button"
                className="helper-nav-more"
                onClick={() => setRecentCount((old) => old + 5)}
              >
                {t('helpers.m331', {
                  count: formatNumber(Math.min(5, recent.length - recentCount)),
                })}
              </button>
            )}
          </section>
        )}
      </div>
    </nav>
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
                props.sessions.toSorted((a, b) =>
                  (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
                ),
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
          {!(props.expanded && props.navigationHost) && (
            <IconButton
              label={t('helpers.m176')}
              icon={Plus}
              disabled={props.creating}
              onClick={props.onCreate}
            />
          )}
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
              <button
                type="button"
                disabled={!props.conversation || !!copying}
                onClick={() => {
                  const session = props.sessions.find((item) => item.id === props.conversation?.id);
                  if (session) void copySession(session);
                }}
              >
                <Copy size={18} aria-hidden="true" />
                {t('helperNavigation.copy')}
              </button>
              <button
                type="button"
                disabled={!props.conversation}
                onClick={() => {
                  const session = props.sessions.find((item) => item.id === props.conversation?.id);
                  if (session) {
                    setMoving(session);
                    setMoveProject(session.projectId ?? '');
                    setProjectError('');
                  }
                }}
              >
                {t('helperNavigation.move')}
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
      </div>
      {props.expanded && props.navigationHost && createPortal(navigation, props.navigationHost)}
      {copyError && !props.navigationHost && (
        <NoticeBanner tone="error">{translateMessage(copyError)}</NoticeBanner>
      )}
      <Dialog
        open={!!projectEditor}
        title={t(
          projectEditor === 'new' ? 'helperNavigation.newProject' : 'helperNavigation.renameProject'
        )}
        onClose={() => {
          if (!projectWorking) setProjectEditor(null);
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!projectEditor || !projectTitle.trim() || projectWorking) return;
            setProjectWorking(true);
            setProjectError('');
            const title = projectTitle.trim();
            void (async () => {
              if (projectEditor === 'new') {
                const key = `uimori:helper-project-create:${title}`;
                type ProjectRequest = { title: string; requestKey: string };
                const pending = pendingHelperRequest(
                  key,
                  () => ({ title, requestKey: crypto.randomUUID() }),
                  (value): value is ProjectRequest => {
                    if (!value || typeof value !== 'object') return false;
                    const item = value as Partial<ProjectRequest>;
                    return (
                      item.title === title &&
                      typeof item.requestKey === 'string' &&
                      item.requestKey.length > 0
                    );
                  }
                );
                try {
                  const created = await api<HelperProject>('/helper/projects', pending.request);
                  setProjects((old) => [
                    ...old.filter((project) => project.id !== created.id),
                    created,
                  ]);
                  setSearch('');
                  setCollapsed((old) => ({ ...old, [created.id]: false }));
                  setFocusProject(created.id);
                } catch (cause) {
                  if (
                    cause instanceof ApiError &&
                    cause.status < 500 &&
                    ![408, 429].includes(cause.status)
                  ) {
                    clearPendingHelperRequest(key, pending);
                  }
                  throw cause;
                }
                clearPendingHelperRequest(key, pending);
              } else {
                await api(
                  `/helper/projects/${encodeURIComponent(projectEditor.id)}`,
                  { title, expectedRevision: projectEditor.revision },
                  'PATCH'
                );
              }
              setProjectEditor(null);
              projectChanged();
            })()
              .catch((cause) =>
                setProjectError(
                  cause instanceof Error ? cause.message : uiMessage('helperNavigation.saveFailed')
                )
              )
              .finally(() => setProjectWorking(false));
          }}
        >
          <label>
            {t('helperNavigation.projectName')}
            <input
              value={projectTitle}
              maxLength={200}
              disabled={projectWorking}
              onChange={(event) => setProjectTitle(event.target.value)}
            />
          </label>
          {projectError && (
            <NoticeBanner tone="error">{translateMessage(projectError)}</NoticeBanner>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="secondary"
              disabled={projectWorking}
              onClick={() => setProjectEditor(null)}
            >
              {t('helpers.m165')}
            </button>
            <SaveButton
              label={t('helperNavigation.saveProject')}
              disabled={!projectTitle.trim()}
              aria-busy={projectWorking}
            />
          </div>
        </form>
      </Dialog>
      <Dialog
        open={!!projectDeleting}
        title={t('helperNavigation.deleteProject')}
        variant="confirmation"
        role="alertdialog"
        onClose={() => {
          if (!projectWorking) setProjectDeleting(null);
        }}
      >
        <p>
          {t('helperNavigation.deleteProjectDescription', { title: projectDeleting?.title ?? '' })}
        </p>
        {projectError && <NoticeBanner tone="error">{translateMessage(projectError)}</NoticeBanner>}
        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            disabled={projectWorking}
            onClick={() => setProjectDeleting(null)}
          >
            {t('helpers.m165')}
          </button>
          <button
            type="button"
            className="delete-button"
            disabled={projectWorking}
            onClick={() => {
              if (!projectDeleting || projectWorking) return;
              setProjectWorking(true);
              setProjectError('');
              void api(
                `/helper/projects/${encodeURIComponent(projectDeleting.id)}`,
                { expectedRevision: projectDeleting.revision },
                'DELETE'
              )
                .then(async () => {
                  setProjectDeleting(null);
                  props.onProjectsChanged?.();
                  projectChanged();
                })
                .catch((cause) =>
                  setProjectError(
                    cause instanceof Error
                      ? cause.message
                      : uiMessage('helperNavigation.saveFailed')
                  )
                )
                .finally(() => setProjectWorking(false));
            }}
          >
            {t('helperNavigation.deleteProject')}
          </button>
        </div>
      </Dialog>
      <Dialog
        open={!!moving}
        title={t('helperNavigation.move')}
        onClose={() => {
          if (!projectWorking) setMoving(null);
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!moving || projectWorking) return;
            setProjectWorking(true);
            setProjectError('');
            void api<HelperConversation>(
              `/helper/conversations/${encodeURIComponent(moving.id)}/project`,
              { projectId: moveProject || null, expectedRevision: moving.revision },
              'PATCH'
            )
              .then((value) => {
                props.onUpdate({ ...value, projectId: moveProject || null } as HelperSession);
                setMoving(null);
                props.onProjectsChanged?.();
              })
              .catch((cause) =>
                setProjectError(
                  cause instanceof Error ? cause.message : uiMessage('helperNavigation.saveFailed')
                )
              )
              .finally(() => setProjectWorking(false));
          }}
        >
          <label>
            {t('helperNavigation.project')}
            <select
              value={moveProject}
              onChange={(event) => setMoveProject(event.target.value)}
              disabled={projectWorking}
            >
              <option value="">{t('helperNavigation.noProject')}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>
          {!projectsLoaded && (
            <button type="button" onClick={() => void reloadProjects()}>
              {t('helperNavigation.retry')}
            </button>
          )}
          {projectError && (
            <NoticeBanner tone="error">{translateMessage(projectError)}</NoticeBanner>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="secondary"
              disabled={projectWorking}
              onClick={() => setMoving(null)}
            >
              {t('helpers.m165')}
            </button>
            <button className="primary" disabled={projectWorking || !projectsLoaded}>
              {t('helperNavigation.move')}
            </button>
          </div>
        </form>
      </Dialog>
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
                  props.onDelete(deleting.id);
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
