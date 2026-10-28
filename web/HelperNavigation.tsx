import { useEffect, useRef, useState, type DragEvent, type RefObject } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  CircleCheck,
  CircleStop,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Inbox,
  LoaderCircle,
  MessageCircle,
  Pencil,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import type { HelperProject } from '../core/helper.js';
import type { HelperSession } from './useHelperSessions.js';
import { t, useI18n, formatDate, formatNumber } from './i18n.js';
import { ActionMenu } from './ActionMenu.js';
import { IconButton } from './IconButton.js';
import { ActivitySection } from './ActivitySection.js';
import { navigationTimeLabel } from './navigation-time.js';
import { groupRecentDates, recentDateGroupLabel } from './recent-date-groups.js';
import {
  helperNavigationLists,
  helperNavigationOrder,
  helperNavigationStorageKey,
  helperSessionActivityAt,
  readHelperNavigationView,
} from './helper-navigation-model.js';
import './bot-tree-navigation.css';
import './helper-session-navigation.css';

type Props = {
  sessions: HelperSession[];
  projects: HelperProject[];
  currentId: string | null;
  unread: string[];
  search: string;
  onSearch: (value: string) => void;
  searchInput: RefObject<HTMLInputElement | null>;
  creating: boolean;
  working: boolean;
  focusProject: string | null;
  activityRequest?: number;
  onFocusedProject: () => void;
  onSelect: (session: HelperSession) => void;
  onAcknowledge?: (ids: string[]) => void;
  onNewProject: () => void;
  onCreate: (projectId?: string | null) => void;
  onRenameProject: (project: HelperProject) => void;
  onDeleteProject: (project: HelperProject) => void;
  onMove: (session: HelperSession, projectId: string | null) => Promise<boolean>;
  sessionMenu: (session: HelperSession, orderActions?: React.ReactNode) => React.ReactNode;
  children?: React.ReactNode;
};
type Drag = { kind: 'project' | 'conversation'; id: string; revision: number };
const resultLabels: Record<string, string> = {
  completed: 'helpers.m004',
  failed: 'helpers.m005',
  cancelled: 'helpers.m006',
  interrupted: 'helpers.m007',
};
export function HelperNavigation(props: Props) {
  useI18n();
  const [view, setView] = useState(readHelperNavigationView);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [drop, setDrop] = useState<{ key: string; after: boolean } | null>(null);
  const moving = useRef(false);
  const headings = useRef(new Map<string, HTMLButtonElement>());
  const lists = helperNavigationLists(props.sessions, props.projects, props.search, view);
  const allLists = helperNavigationLists(props.sessions, props.projects, '', view);
  useEffect(() => {
    if (props.activityRequest) setView((old) => ({ ...old, mode: 'activity' }));
  }, [props.activityRequest]);
  useEffect(() => {
    try {
      localStorage.setItem(helperNavigationStorageKey, JSON.stringify(view));
    } catch {
      /* Navigation preferences remain available for this window. */
    }
  }, [view]);
  useEffect(() => {
    const id = props.focusProject;
    if (!id) return;
    setView((old) => ({ ...old, mode: 'projects', collapsed: { ...old.collapsed, [id]: false } }));
    const frame = requestAnimationFrame(() => {
      const heading = headings.current.get(id);
      if (!heading) return;
      heading.scrollIntoView({ block: 'nearest' });
      heading.focus();
      props.onFocusedProject();
    });
    return () => cancelAnimationFrame(frame);
  }, [props.focusProject, props.onFocusedProject]);
  const clearDrag = () => {
    dragRef.current = null;
    setDrag(null);
    setDrop(null);
  };
  const startDrag = (event: DragEvent, source: Drag) => {
    if ((event.target as HTMLElement).closest('.action-menu')) {
      event.preventDefault();
      return;
    }
    dragRef.current = source;
    setDrag(source);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-uimori-helper', `${source.kind}:${source.id}`);
  };
  const over = (event: DragEvent, key: string) => {
    const source = dragRef.current;
    if (!source || props.working || moving.current) return;
    if (source.kind === 'project' && !key.startsWith('project:')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    setDrop({ key, after: event.clientY > rect.top + rect.height / 2 });
  };
  const dropOn = async (
    event: DragEvent,
    target: HelperProject | HelperSession | null,
    kind: 'project' | 'conversation' | 'unfiled'
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const source = dragRef.current;
    const after = drop?.after ?? false;
    clearDrag();
    if (!source || props.working || moving.current) return;
    if (source.kind === 'project') {
      if (kind !== 'project' || !target || source.id === target.id) return;
      setView((old) => ({
        ...old,
        sort: 'manual',
        order: helperNavigationOrder(
          old.order,
          allLists.projects.map((project) => `project:${project.id}`),
          `project:${source.id}`,
          `project:${target.id}`,
          after
        ),
      }));
      return;
    }
    const session = props.sessions.find((item) => item.id === source.id);
    if (!session || source.revision !== session.revision) return;
    const projectId =
      kind === 'project'
        ? target!.id
        : kind === 'conversation'
          ? ((target as HelperSession).projectId ?? null)
          : null;
    if (kind === 'conversation' && source.id === target?.id) return;
    if ((session.projectId ?? null) !== projectId) {
      moving.current = true;
      try {
        if (!(await props.onMove(session, projectId))) return;
      } finally {
        moving.current = false;
      }
    }
    const siblings = projectId ? allLists.inProject(projectId) : allLists.unfiled;
    setView((old) => ({
      ...old,
      sort: 'manual',
      collapsed: { ...old.collapsed, ...(projectId ? { [projectId]: false } : {}) },
      order: helperNavigationOrder(
        old.order,
        siblings.map((item) => `conversation:${item.id}`),
        `conversation:${session.id}`,
        kind === 'conversation' ? `conversation:${target!.id}` : undefined,
        after
      ),
    }));
  };
  const dragClass = (key: string) =>
    `${drag && `${drag.kind}:${drag.id}` === key ? ' tree-dragging' : ''}${drop?.key === key ? ` tree-drop-target tree-drop-${drop.after ? 'after' : 'before'}` : ''}`;
  const projectName = (session: HelperSession) =>
    props.projects.find((project) => project.id === session.projectId)?.title;
  const orderMenu = (key: string, siblings: string[], allSiblings: string[]) => {
    if (siblings.length < 2) return undefined;
    const index = siblings.indexOf(key);
    const reorder = (step: -1 | 1) =>
      setView((old) => ({
        ...old,
        sort: 'manual',
        order: helperNavigationOrder(old.order, allSiblings, key, siblings[index + step], step > 0),
      }));
    return (
      <div className="action-menu-group">
        <button type="button" disabled={props.working || index <= 0} onClick={() => reorder(-1)}>
          <ArrowUp size={18} aria-hidden="true" />
          {t('helperNavigation.moveUp')}
        </button>
        <button
          type="button"
          disabled={props.working || index >= siblings.length - 1}
          onClick={() => reorder(1)}
        >
          <ArrowDown size={18} aria-hidden="true" />
          {t('helperNavigation.moveDown')}
        </button>
      </div>
    );
  };
  const row = (session: HelperSession, section: 'tree' | 'unread' | 'running' | 'recent') => {
    const at = helperSessionActivityAt(session);
    const running = (session.activity?.running ?? 0) + (session.activity?.queued ?? 0);
    const Icon =
      section === 'unread'
        ? session.lastTaskStatus === 'completed'
          ? CircleCheck
          : session.lastTaskStatus === 'cancelled' || session.lastTaskStatus === 'interrupted'
            ? CircleStop
            : AlertCircle
        : section === 'running'
          ? LoaderCircle
          : MessageCircle;
    const detail =
      section === 'unread' && session.lastTaskStatus
        ? t(resultLabels[session.lastTaskStatus] ?? 'helpers.m263')
        : section === 'running' || (section === 'tree' && running)
          ? session.activity?.running
            ? t('helpers.m113')
            : t('helpers.queuedCount', { count: formatNumber(running) })
          : undefined;
    const context = section !== 'tree' ? (projectName(session) ?? session.chatTitle) : undefined;
    return (
      <div
        key={session.id}
        data-conversation-id={session.id}
        className={`activity-nav-chat-row helper-nav-row${section === 'tree' ? dragClass(`conversation:${session.id}`) : ''}`}
        draggable={section === 'tree' && !props.working}
        onDragStart={
          section === 'tree'
            ? (event) =>
                startDrag(event, {
                  kind: 'conversation',
                  id: session.id,
                  revision: session.revision,
                })
            : undefined
        }
        onDragEnd={clearDrag}
        onDragOver={
          section === 'tree' ? (event) => over(event, `conversation:${session.id}`) : undefined
        }
        onDrop={
          section === 'tree' ? (event) => void dropOn(event, session, 'conversation') : undefined
        }
      >
        <button
          type="button"
          className={`activity-nav-link${session.id === props.currentId ? ' selected' : ''}`}
          aria-current={session.id === props.currentId ? 'page' : undefined}
          onClick={() => props.onSelect(session)}
        >
          <Icon
            size={16}
            aria-hidden="true"
            className={
              section === 'unread'
                ? session.lastTaskStatus === 'failed' || session.lastTaskStatus === 'interrupted'
                  ? 'activity-nav-warning'
                  : session.lastTaskStatus === 'completed'
                    ? 'activity-nav-success'
                    : undefined
                : undefined
            }
          />
          <span className="activity-nav-copy">
            <strong>{session.title || t('helpers.m173')}</strong>
            <small className="activity-nav-detail">
              {(context || detail) && (
                <span className="ui-meta-row">
                  {context && <span>{context}</span>}
                  {detail && <span>{detail}</span>}
                </span>
              )}
              <time dateTime={at} title={formatDate(at)}>
                {navigationTimeLabel(at)}
              </time>
            </small>
          </span>
          {session.id === props.currentId && <Check size={14} aria-hidden="true" />}
        </button>
        {section === 'unread' && props.onAcknowledge && (
          <IconButton
            className="helper-nav-acknowledge"
            icon={Check}
            label={t('helperNavigation.acknowledge', { title: session.title || t('helpers.m173') })}
            onClick={() => props.onAcknowledge?.([session.id])}
          />
        )}
        {props.sessionMenu(
          session,
          section === 'tree'
            ? orderMenu(
                `conversation:${session.id}`,
                (session.projectId &&
                props.projects.some((project) => project.id === session.projectId)
                  ? lists.inProject(session.projectId)
                  : lists.unfiled
                ).map((item) => `conversation:${item.id}`),
                (session.projectId &&
                props.projects.some((project) => project.id === session.projectId)
                  ? allLists.inProject(session.projectId)
                  : allLists.unfiled
                ).map((item) => `conversation:${item.id}`)
              )
            : undefined
        )}
      </div>
    );
  };
  const unread = lists.recent.filter((session) => props.unread.includes(session.id));
  const running = lists.recent.filter(
    (session) => session.activity?.running || session.activity?.queued
  );
  const sectionStorage = 'uimori:helper-activity-sections:v1';
  return (
    <nav
      className="helper-navigation"
      aria-label={t('helpers.sessions')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') clearDrag();
      }}
    >
      <nav
        className="bot-navigation-modes helper-navigation-modes"
        aria-label={t('helperNavigation.views')}
      >
        <button
          type="button"
          aria-pressed={view.mode === 'projects'}
          aria-label={t('helperNavigation.explore')}
          title={t('helperNavigation.explore')}
          onClick={() => setView((old) => ({ ...old, mode: 'projects' }))}
        >
          <Folder size={19} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-pressed={view.mode === 'activity'}
          aria-label={t('helperNavigation.activityCount', { count: props.unread.length })}
          title={t('helpers.m262')}
          onClick={() => setView((old) => ({ ...old, mode: 'activity' }))}
        >
          <Inbox size={19} aria-hidden="true" />
          {props.unread.length > 0 && (
            <span className="activity-mode-count">{formatNumber(props.unread.length)}</span>
          )}
        </button>
      </nav>
      <div className="helper-navigation-tools">
        <input
          ref={props.searchInput}
          type="search"
          aria-label={t('helpers.searchSessions')}
          placeholder={t('helpers.searchSessions')}
          value={props.search}
          onChange={(event) => props.onSearch(event.target.value)}
        />
        <IconButton
          label={t('helperNavigation.newProject')}
          icon={FolderPlus}
          onClick={props.onNewProject}
        />
        {view.mode === 'projects' && (
          <ActionMenu label={t('helperNavigation.sort')} icon={SlidersHorizontal} viewport>
            <label>
              {t('helperNavigation.sort')}
              <select
                aria-label={t('helperNavigation.sort')}
                value={view.sort}
                onChange={(event) =>
                  setView((old) => ({
                    ...old,
                    sort:
                      event.target.value === 'manual'
                        ? 'manual'
                        : event.target.value === 'name'
                          ? 'name'
                          : 'recent',
                  }))
                }
              >
                <option value="manual">{t('transfer.m296')}</option>
                <option value="recent">{t('transfer.m295')}</option>
                <option value="name">{t('helperNavigation.sortName')}</option>
              </select>
            </label>
          </ActionMenu>
        )}
      </div>
      {props.children}
      <div className="helper-navigation-scroll">
        {view.mode === 'projects' ? (
          <div className="helper-navigation-tree">
            {lists.projects.map((project) => (
              <section
                className="bot-tree-folder helper-nav-group"
                key={project.id}
                data-helper-project-id={project.id}
                aria-label={project.title}
              >
                <div
                  className={`bot-tree-folder-heading helper-nav-project-heading${dragClass(`project:${project.id}`)}`}
                  draggable={!props.working}
                  onDragStart={(event) =>
                    startDrag(event, {
                      kind: 'project',
                      id: project.id,
                      revision: project.revision,
                    })
                  }
                  onDragEnd={clearDrag}
                  onDragOver={(event) => over(event, `project:${project.id}`)}
                  onDrop={(event) => void dropOn(event, project, 'project')}
                >
                  <button
                    type="button"
                    className="helper-nav-heading"
                    aria-expanded={!view.collapsed[project.id] || !!props.search.trim()}
                    ref={(node) => {
                      if (node) headings.current.set(project.id, node);
                      else headings.current.delete(project.id);
                    }}
                    onClick={() =>
                      setView((old) => ({
                        ...old,
                        collapsed: { ...old.collapsed, [project.id]: !old.collapsed[project.id] },
                      }))
                    }
                  >
                    {view.collapsed[project.id] && !props.search.trim() ? (
                      <ChevronRight size={14} aria-hidden="true" />
                    ) : (
                      <ChevronDown size={14} aria-hidden="true" />
                    )}
                    <Folder size={16} aria-hidden="true" />
                    <span>{project.title}</span>
                  </button>
                  <ActionMenu
                    label={t('helperNavigation.projectActions', { title: project.title })}
                    viewport
                  >
                    <div className="action-menu-group">
                      <button
                        type="button"
                        disabled={props.creating}
                        onClick={() => {
                          props.onSearch('');
                          setView((old) => ({
                            ...old,
                            collapsed: { ...old.collapsed, [project.id]: false },
                          }));
                          props.onCreate(project.id);
                        }}
                      >
                        <MessageCircle size={18} aria-hidden="true" />
                        {t('helpers.m173')}
                      </button>
                      <button type="button" onClick={() => props.onRenameProject(project)}>
                        <Pencil size={18} aria-hidden="true" />
                        {t('helperNavigation.renameProject')}
                      </button>
                    </div>
                    {orderMenu(
                      `project:${project.id}`,
                      lists.projects.map((item) => `project:${item.id}`),
                      allLists.projects.map((item) => `project:${item.id}`)
                    )}
                    <div className="action-menu-group">
                      <button
                        type="button"
                        className="danger"
                        onClick={() => props.onDeleteProject(project)}
                      >
                        <Trash2 size={18} aria-hidden="true" />
                        {t('helperNavigation.deleteProject')}
                      </button>
                    </div>
                  </ActionMenu>
                </div>
                {(!view.collapsed[project.id] || !!props.search.trim()) && (
                  <div className="bot-tree-folder-contents helper-nav-project-contents">
                    {lists.inProject(project.id).map((session) => row(session, 'tree'))}
                  </div>
                )}
              </section>
            ))}
            <section
              className={`helper-nav-unfiled${drop?.key === 'unfiled' ? ' tree-drop-target' : ''}`}
              aria-label={t('helperNavigation.noProject')}
              onDragOver={(event) => over(event, 'unfiled')}
              onDrop={(event) => void dropOn(event, null, 'unfiled')}
            >
              {lists.unfiled.map((session) => row(session, 'tree'))}
              {drag?.kind === 'conversation' && (
                <div className="bot-tree-unfiled-drop">{t('helperNavigation.noProject')}</div>
              )}
            </section>
            {props.search.trim() && !lists.projects.length && !lists.recent.length && (
              <p className="activity-nav-empty" role="status">
                {t('library.noSearchResults')}
              </p>
            )}
          </div>
        ) : props.search.trim() && !lists.recent.length ? (
          <p className="activity-nav-empty" role="status">
            {t('library.noSearchResults')}
          </p>
        ) : (
          <div className="activity-navigation helper-activity-navigation">
            <ActivitySection
              id="unread"
              storageKey={sectionStorage}
              label={t('helpers.m263')}
              total={unread.length}
              empty={t('helpers.m264')}
            >
              {(limit) => unread.slice(0, limit).map((session) => row(session, 'unread'))}
            </ActivitySection>
            <ActivitySection
              id="running"
              storageKey={sectionStorage}
              label={t('helpers.m113')}
              total={running.length}
              empty={t('helpers.m268')}
            >
              {(limit) => running.slice(0, limit).map((session) => row(session, 'running'))}
            </ActivitySection>
            <ActivitySection
              id="recent"
              storageKey={sectionStorage}
              label={t('helperNavigation.recent')}
              total={lists.recent.length}
              empty={t('helpers.m271')}
            >
              {(limit) =>
                groupRecentDates(lists.recent.slice(0, limit), helperSessionActivityAt).map(
                  (group, index) => (
                    <div className="activity-nav-date-group" key={`${group.key}:${index}`}>
                      <h3>{recentDateGroupLabel(group)}</h3>
                      {group.items.map((session) => row(session, 'recent'))}
                    </div>
                  )
                )
              }
            </ActivitySection>
          </div>
        )}
      </div>
    </nav>
  );
}
