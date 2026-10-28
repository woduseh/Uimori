import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HelperProject } from '../core/helper.js';
import type { HelperSession } from '../web/useHelperSessions.js';
import { HelperNavigation } from '../web/HelperNavigation.js';
import {
  helperNavigationLists,
  helperNavigationOrder,
  helperNavigationStorageKey,
  readHelperNavigationView,
} from '../web/helper-navigation-model.js';

const projects: HelperProject[] = [
  { id: 'p1', title: '첫 프로젝트', revision: 0 },
  { id: 'p2', title: '다른 프로젝트', revision: 0 },
];
const session = (
  id: string,
  title: string,
  projectId: string | null,
  at: string
): HelperSession => ({
  id,
  title,
  projectId,
  revision: 0,
  scope: { kind: 'library', workId: 'workspace' },
  persona: '',
  limits: { totalCalls: 128, helperCalls: 128 },
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: at,
  lastActivityAt: at,
});
const sessions = [
  session('one', '가 대화', 'p1', '2026-10-27T01:00:00Z'),
  session('two', '나 대화', 'p1', '2026-10-28T01:00:00Z'),
  session('three', '다 대화', null, '2026-10-26T01:00:00Z'),
  session('four', '라 대화', 'deleted-project', '2026-10-25T01:00:00Z'),
];
afterEach(() => vi.unstubAllGlobals());

describe('helper navigation ownership and order', () => {
  it('places each conversation once in its project or the root and keeps all in recent', () => {
    const lists = helperNavigationLists(sessions, projects, '', { sort: 'recent', order: [] });
    expect(lists.inProject('p1').map((item) => item.id)).toEqual(['two', 'one']);
    expect(lists.unfiled.map((item) => item.id)).toEqual(['three', 'four']);
    const tree = [...lists.inProject('p1'), ...lists.inProject('p2'), ...lists.unfiled];
    expect(tree.map((item) => item.id).toSorted()).toEqual(['four', 'one', 'three', 'two']);
    expect(lists.recent.map((item) => item.id)).toEqual(['two', 'one', 'three', 'four']);
  });
  it('changes tree sorting without reordering activity or mutating authored input', () => {
    const renamed = sessions.map((item) =>
      item.id === 'one' ? { ...item, updatedAt: '2026-10-29T01:00:00Z' } : item
    );
    const lists = helperNavigationLists(renamed, projects, '', {
      sort: 'manual',
      order: ['project:p2', 'project:p1', 'conversation:one', 'conversation:two'],
    });
    expect(lists.projects.map((item) => item.id)).toEqual(['p2', 'p1']);
    expect(lists.inProject('p1').map((item) => item.id)).toEqual(['one', 'two']);
    expect(lists.recent.map((item) => item.id)).toEqual(['two', 'one', 'three', 'four']);
    expect(renamed[0].title).toBe('가 대화');
    const names = helperNavigationLists(sessions, projects, '', { sort: 'name', order: [] });
    expect(names.inProject('p1').map((item) => item.id)).toEqual(['one', 'two']);
  });
  it('finds a project by its name and a child by its conversation name', () => {
    const byProject = helperNavigationLists(sessions, projects, ' 첫 프로젝트 ', {
      sort: 'recent',
      order: [],
    });
    expect(byProject.projects.map((item) => item.id)).toEqual(['p1']);
    expect(byProject.recent.map((item) => item.id)).toEqual(['two', 'one']);
    const byConversation = helperNavigationLists(sessions, projects, '가 대화', {
      sort: 'recent',
      order: [],
    });
    expect(byConversation.projects.map((item) => item.id)).toEqual(['p1']);
    expect(byConversation.inProject('p1').map((item) => item.id)).toEqual(['one']);
  });
  it('reorders destination siblings and retains the remembered order elsewhere', () => {
    const current = ['project:p1', 'conversation:other', 'conversation:a', 'conversation:b'];
    expect(
      helperNavigationOrder(
        current,
        ['conversation:a', 'conversation:b'],
        'conversation:b',
        'conversation:a'
      )
    ).toEqual(['project:p1', 'conversation:other', 'conversation:b', 'conversation:a']);
    expect(
      helperNavigationOrder(
        current,
        ['conversation:a', 'conversation:b'],
        'conversation:new',
        'conversation:a',
        true
      )
    ).toEqual([
      'project:p1',
      'conversation:other',
      'conversation:a',
      'conversation:new',
      'conversation:b',
    ]);
  });
  it('keeps navigation usable when preference storage fails', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('disabled');
      },
    });
    expect(readHelperNavigationView()).toEqual({
      mode: 'projects',
      sort: 'recent',
      order: [],
      collapsed: {},
    });
  });
  it('moves a searched conversation within its full sibling order without moving hidden siblings', () => {
    const values = ['A', 'B', 'C', 'D', 'E'].map((id) =>
      session(id, ['B', 'D'].includes(id) ? `검색 ${id}` : id, 'p1', '2026-10-28T01:00:00Z')
    );
    const current = values.map((item) => `conversation:${item.id}`);
    const view = { sort: 'manual' as const, order: current };
    const visible = helperNavigationLists(values, projects, '검색', view);
    const all = helperNavigationLists(values, projects, '', view);
    expect(visible.inProject('p1').map((item) => item.id)).toEqual(['B', 'D']);
    expect(
      helperNavigationOrder(
        current,
        all.inProject('p1').map((item) => `conversation:${item.id}`),
        'conversation:D',
        'conversation:B'
      )
    ).toEqual([
      'conversation:A',
      'conversation:D',
      'conversation:B',
      'conversation:C',
      'conversation:E',
    ]);
  });
});

const render = () =>
  renderToStaticMarkup(
    createElement(HelperNavigation, {
      sessions,
      projects,
      currentId: 'one',
      unread: ['two'],
      search: '',
      onSearch: () => {},
      searchInput: { current: null },
      creating: false,
      working: false,
      focusProject: null,
      onFocusedProject: () => {},
      onSelect: () => {},
      onAcknowledge: () => {},
      onNewProject: () => {},
      onCreate: () => {},
      onRenameProject: () => {},
      onDeleteProject: () => {},
      onMove: async () => true,
      sessionMenu: (_session, orderActions) => orderActions,
    })
  );
describe('helper navigation presentation', () => {
  it('renders a nonduplicated tree with project children and project actions', () => {
    const html = render();
    for (const item of sessions)
      expect(html.split(`data-conversation-id="${item.id}"`)).toHaveLength(2);
    expect(html).toContain('bot-tree-folder-contents helper-nav-project-contents');
    expect(html).toContain('첫 프로젝트 프로젝트 메뉴');
    expect(html).toContain('aria-label="활동, 미확인 1개"');
    expect(html).toContain('위로 이동');
    expect(html).toContain('아래로 이동');
    expect(html.split('<span>첫 프로젝트</span>')).toHaveLength(2);
    expect(html).not.toContain('<span>프로젝트 없음</span>');
  });
  it('renders complete recent activity separately from unread and running sections', () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) =>
        key === helperNavigationStorageKey
          ? JSON.stringify({ mode: 'activity', sort: 'name' })
          : null,
    });
    const html = render();
    expect(html).toContain('data-activity-section="unread"');
    expect(html).toContain('data-activity-section="running"');
    const recent = html.slice(html.indexOf('data-activity-section="recent"'));
    for (const item of sessions) expect(recent).toContain(`data-conversation-id="${item.id}"`);
    expect(recent.indexOf('data-conversation-id="two"')).toBeLessThan(
      recent.indexOf('data-conversation-id="one"')
    );
    expect(html).toContain('나 대화 활동 확인');
  });
});
