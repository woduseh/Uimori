import { useEffect, useId, useRef, useState, type DragEvent, type RefObject } from 'react';
import { ArrowDown, ArrowUp, Check, Folder, Pencil, Trash2 } from 'lucide-react';
import {
  AddIcon,
  DoneIcon,
  ExpandIcon,
  FolderAddIcon,
  IssueIcon,
  RunningIcon,
  SearchIcon,
  StopIcon,
} from './ui-icons.js';
import type { HelperProject } from '../core/helper.js';
import type { HelperSession } from './useHelperSessions.js';
import { t, useI18n, formatDate, formatNumber } from './i18n.js';
import { ActionMenu } from './ActionMenu.js';
import { IconButton } from './IconButton.js';
import { ActivitySection } from './ActivitySection.js';
import { NavigationModeTabs } from './NavigationModeTabs.js';
import { navigationTimeLabel } from './navigation-time.js';
import { groupRecentDates, recentDateGroupLabel } from './recent-date-groups.js';
import {
  helperNavigationLists,
  helperNavigationOrder,
  helperNavigationStorageKey,
  helperSessionActivityAt,
  helperSessionTitle,
  readHelperNavigationView,
} from './helper-navigation-model.js';
import './bot-navigation.css';
import './bot-tree-navigation.css';
import './helper-session-navigation.css';
import './content-picker.css';
import './activity-status.css';
import { writeOptionalStorage } from './optional-storage.js';
import { storageKeys } from './storage-keys.js';

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
  const modePanelId = useId();
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
    writeOptionalStorage('local', helperNavigationStorageKey, JSON.stringify(view));
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
  const runningLabel = (session: HelperSession) => {
    const count = (session.activity?.running ?? 0) + (session.activity?.queued ?? 0);
    if (!count) return undefined;
    return session.activity?.running
      ? t('helpers.m113')
      : t('helpers.queuedCount', { count: formatNumber(count) });
  };
  const endedLabel = (session: HelperSession) => {
    const label =
      session.lastTaskStatus !== 'completed' && resultLabels[session.lastTaskStatus ?? ''];
    return label && !runningLabel(session) ? t(label) : undefined;
  };
  const endedIcon = (session: HelperSession) =>
    session.lastTaskStatus === 'cancelled' ? StopIcon : IssueIcon;
  const treeRow = (session: HelperSession) => {
    const selected = session.id === props.currentId;
    const status = runningLabel(session);
    const ended = endedLabel(session);
    const Ended = endedIcon(session);
    const siblings = (source: typeof lists) =>
      (session.projectId && props.projects.some((project) => project.id === session.projectId)
        ? source.inProject(session.projectId)
        : source.unfiled
      ).map((item) => `conversation:${item.id}`);
    return (
      <div
        key={session.id}
        data-conversation-id={session.id}
        className={`bot-chat-item helper-nav-row${selected ? ' selected' : ''}${dragClass(`conversation:${session.id}`)}`}
        draggable={!props.working}
        onDragStart={(event) =>
          startDrag(event, { kind: 'conversation', id: session.id, revision: session.revision })
        }
        onDragEnd={clearDrag}
        onDragOver={(event) => over(event, `conversation:${session.id}`)}
        onDrop={(event) => void dropOn(event, session, 'conversation')}
      >
        <button
          type="button"
          className="chat-link"
          title={helperSessionTitle(session)}
          aria-current={selected ? 'page' : undefined}
          onClick={() => props.onSelect(session)}
        >
          <strong>{helperSessionTitle(session)}</strong>
        </button>
        {status && (
          <span
            className="bot-chat-status"
            tabIndex={0}
            role="img"
            aria-label={status}
            title={status}
          >
            <RunningIcon size={14} aria-hidden="true" />
          </span>
        )}
        {ended && (
          <span
            className={`bot-chat-status helper-nav-ended${session.lastTaskStatus === 'cancelled' ? '' : ' helper-nav-issue'}`}
            tabIndex={0}
            role="img"
            aria-label={ended}
            title={ended}
          >
            <Ended size={14} aria-hidden="true" />
          </span>
        )}
        <div className="bot-row-actions">
          {props.sessionMenu(
            session,
            orderMenu(`conversation:${session.id}`, siblings(lists), siblings(allLists))
          )}
        </div>
      </div>
    );
  };
  const activityRow = (session: HelperSession, section: 'unread' | 'running' | 'recent') => {
    const at = helperSessionActivityAt(session);
    const selected = session.id === props.currentId;
    const ended = section === 'recent' ? endedLabel(session) : undefined;
    const Icon =
      section === 'unread'
        ? session.lastTaskStatus === 'completed'
          ? DoneIcon
          : session.lastTaskStatus === 'cancelled' || session.lastTaskStatus === 'interrupted'
            ? StopIcon
            : IssueIcon
        : section === 'running'
          ? RunningIcon
          : ended
            ? endedIcon(session)
            : null;
    const tone =
      section === 'running'
        ? 'activity-spinner'
        : section === 'unread'
          ? session.lastTaskStatus === 'failed' || session.lastTaskStatus === 'interrupted'
            ? 'activity-nav-warning'
            : session.lastTaskStatus === 'completed'
              ? 'activity-nav-success'
              : undefined
          : ended && session.lastTaskStatus !== 'cancelled'
            ? 'activity-nav-warning'
            : undefined;
    const detail =
      section === 'unread' && session.lastTaskStatus
        ? t(resultLabels[session.lastTaskStatus] ?? 'helpers.m263')
        : section === 'running'
          ? runningLabel(session)
          : ended;
    const context = projectName(session) ?? session.chatTitle;
    const link = (
      <button
        type="button"
        className={`activity-nav-link${selected ? ' selected' : ''}`}
        aria-current={selected ? 'page' : undefined}
        onClick={() => props.onSelect(session)}
      >
        {Icon && section !== 'recent' && <Icon size={16} aria-hidden="true" className={tone} />}
        <span className="activity-nav-copy">
          <strong>{helperSessionTitle(session)}</strong>
          <small className="activity-nav-detail">
            {(context || detail) && (
              <span className="ui-meta-row">
                {context && <span>{context}</span>}
                {detail && (
                  <span className={section === 'recent' ? 'activity-nav-state' : undefined}>
                    {Icon && section === 'recent' && (
                      <Icon size={14} aria-hidden="true" className={tone} />
                    )}
                    {detail}
                  </span>
                )}
              </span>
            )}
            <time dateTime={at} title={formatDate(at)}>
              {navigationTimeLabel(at)}
            </time>
          </small>
        </span>
      </button>
    );
    if (section === 'recent')
      return (
        <div key={session.id} data-conversation-id={session.id} className="activity-nav-chat-row">
          {link}
          {props.sessionMenu(session)}
        </div>
      );
    return (
      <div key={session.id} data-conversation-id={session.id} className="activity-nav-entry">
        {link}
        {section === 'unread' && props.onAcknowledge && (
          <IconButton
            className="activity-nav-confirm"
            label={t('helperNavigation.acknowledge', { title: helperSessionTitle(session) })}
            title={t('helpers.m267')}
            icon={Check}
            size={16}
            onClick={() => props.onAcknowledge?.([session.id])}
          />
        )}
      </div>
    );
  };
  const unread = lists.recent.filter((session) => props.unread.includes(session.id));
  const running = lists.recent.filter(
    (session) => session.activity?.running || session.activity?.queued
  );
  const sectionStorage = storageKeys.helperActivitySections;
  return (
    <nav
      className="helper-navigation"
      aria-label={t('helpers.sessions')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') clearDrag();
      }}
    >
      <NavigationModeTabs
        label={t('helperNavigation.views')}
        panelId={modePanelId}
        active={view.mode}
        onSelect={(mode) => setView((old) => ({ ...old, mode }))}
        tabs={[
          { value: 'projects', label: t('helperNavigation.explore') },
          {
            value: 'activity',
            accessibleName: t('helperNavigation.activityCount', { count: props.unread.length }),
            label: (
              <>
                {t('transfer.m292')}
                {props.unread.length > 0 && (
                  <span className="activity-mode-count">{formatNumber(props.unread.length)}</span>
                )}
              </>
            ),
          },
        ]}
        actions={
          <div className="bot-row-actions">
            {view.mode === 'projects' && (
              <ActionMenu label={t('helperNavigation.listActions')} viewport>
                <div className="action-menu-group">
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
                      <option value="recent">{t('helperNavigation.sortRecent')}</option>
                      <option value="name">{t('helperNavigation.sortName')}</option>
                    </select>
                  </label>
                </div>
                <div className="action-menu-group">
                  <button type="button" onClick={props.onNewProject}>
                    <FolderAddIcon size={16} aria-hidden="true" />
                    {t('helperNavigation.newProject')}
                  </button>
                </div>
              </ActionMenu>
            )}
          </div>
        }
      />
      <span className="content-picker-search-field helper-navigation-search">
        <SearchIcon size={16} aria-hidden="true" />
        <input
          ref={props.searchInput}
          type="search"
          aria-label={t('helpers.searchSessions')}
          placeholder={t('helpers.searchSessions')}
          value={props.search}
          onChange={(event) => props.onSearch(event.target.value)}
        />
      </span>
      {props.children}
      <div
        className="helper-navigation-scroll"
        id={modePanelId}
        role="tabpanel"
        aria-labelledby={`${modePanelId}-${view.mode}`}
      >
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
                    className="bot-folder-toggle"
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
                    <ExpandIcon
                      size={12}
                      aria-hidden="true"
                      className={
                        !view.collapsed[project.id] || props.search.trim() ? 'expanded' : ''
                      }
                    />
                    <Folder size={16} aria-hidden="true" />
                    <span>{project.title}</span>
                  </button>
                  <div className="bot-row-actions">
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
                          <AddIcon size={18} aria-hidden="true" />
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
                </div>
                {(!view.collapsed[project.id] || !!props.search.trim()) && (
                  <div className="bot-tree-folder-contents helper-nav-project-contents">
                    {lists.inProject(project.id).map(treeRow)}
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
              {lists.unfiled.map(treeRow)}
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
              action={
                props.onAcknowledge &&
                unread.length > 0 && (
                  <button
                    type="button"
                    className="activity-nav-acknowledge-all"
                    onClick={() => props.onAcknowledge?.(unread.map((session) => session.id))}
                  >
                    {t('helpers.m286')}
                  </button>
                )
              }
            >
              {(limit) => unread.slice(0, limit).map((session) => activityRow(session, 'unread'))}
            </ActivitySection>
            <ActivitySection
              id="running"
              storageKey={sectionStorage}
              label={t('helpers.m113')}
              total={running.length}
            >
              {(limit) => running.slice(0, limit).map((session) => activityRow(session, 'running'))}
            </ActivitySection>
            <ActivitySection
              id="recent"
              storageKey={sectionStorage}
              label={t('helperNavigation.recent')}
              total={lists.recent.length}
              empty={t('helperNavigation.noRecent')}
            >
              {(limit) =>
                groupRecentDates(lists.recent.slice(0, limit), helperSessionActivityAt).map(
                  (group, index) => (
                    <div className="activity-nav-date-group" key={`${group.key}:${index}`}>
                      <h3>{recentDateGroupLabel(group)}</h3>
                      {group.items.map((session) => activityRow(session, 'recent'))}
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
