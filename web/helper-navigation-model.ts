import type { HelperProject } from '../core/helper.js';
import type { HelperSession } from './useHelperSessions.js';

export type HelperNavigationView = {
  mode: 'projects' | 'activity';
  sort: 'manual' | 'recent' | 'name';
  order: string[];
  collapsed: Record<string, boolean>;
};
export const helperNavigationStorageKey = 'uimori:helper-navigation:v1';
export function readHelperNavigationView(): HelperNavigationView {
  try {
    const value = JSON.parse(localStorage.getItem(helperNavigationStorageKey) ?? 'null');
    return {
      mode: value?.mode === 'activity' ? 'activity' : 'projects',
      sort: value?.sort === 'manual' || value?.sort === 'name' ? value.sort : 'recent',
      order: Array.isArray(value?.order)
        ? value.order.filter((key: unknown) => typeof key === 'string')
        : [],
      collapsed:
        value?.collapsed && typeof value.collapsed === 'object' && !Array.isArray(value.collapsed)
          ? (Object.fromEntries(
              Object.entries(value.collapsed).filter(
                ([, expanded]) => typeof expanded === 'boolean'
              )
            ) as Record<string, boolean>)
          : {},
    };
  } catch {
    return { mode: 'projects', sort: 'recent', order: [], collapsed: {} };
  }
}
export const helperSessionActivityAt = (session: HelperSession) =>
  session.lastActivityAt ?? session.updatedAt ?? session.createdAt;

/** Search and tree ownership are independent: every conversation has exactly one tree location. */
export function helperNavigationLists(
  sessions: HelperSession[],
  projects: HelperProject[],
  search: string,
  view: Pick<HelperNavigationView, 'sort' | 'order'>
) {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const query = search.trim().toLocaleLowerCase();
  const filtered = sessions.filter((session) =>
    [session.title, session.chatTitle, projectById.get(session.projectId ?? '')?.title]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase()
      .includes(query)
  );
  const recent = filtered.toSorted(
    (a, b) =>
      helperSessionActivityAt(b).localeCompare(helperSessionActivityAt(a)) ||
      b.id.localeCompare(a.id)
  );
  const rank = new Map(view.order.map((key, index) => [key, index]));
  const manual = (a: string, b: string) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity);
  const conversations = recent.toSorted((a, b) =>
    view.sort === 'name'
      ? (a.title ?? '').localeCompare(b.title ?? '') || a.id.localeCompare(b.id)
      : view.sort === 'manual'
        ? manual(`conversation:${a.id}`, `conversation:${b.id}`)
        : 0
  );
  const latest = (project: HelperProject) =>
    recent.find((session) => session.projectId === project.id);
  const orderedProjects = projects
    .filter(
      (project) =>
        !query ||
        project.title.toLocaleLowerCase().includes(query) ||
        filtered.some((session) => session.projectId === project.id)
    )
    .toSorted((a, b) =>
      view.sort === 'name'
        ? a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
        : view.sort === 'manual'
          ? manual(`project:${a.id}`, `project:${b.id}`)
          : (latest(b) ? helperSessionActivityAt(latest(b)!) : '').localeCompare(
              latest(a) ? helperSessionActivityAt(latest(a)!) : ''
            )
    );
  return {
    recent,
    projects: orderedProjects,
    inProject: (id: string) => conversations.filter((session) => session.projectId === id),
    unfiled: conversations.filter((session) => !projectById.has(session.projectId ?? '')),
  };
}

/** Reorder only the destination siblings, retaining remembered positions elsewhere. */
export function helperNavigationOrder(
  current: string[],
  siblings: string[],
  source: string,
  target?: string,
  after = false
) {
  const ordered = siblings.filter((key) => key !== source);
  const index = target ? ordered.indexOf(target) : -1;
  ordered.splice(index < 0 ? ordered.length : index + Number(after), 0, source);
  return [...current.filter((key) => !ordered.includes(key)), ...ordered];
}
