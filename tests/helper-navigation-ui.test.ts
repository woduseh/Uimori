import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HelperProject } from '../core/helper.js';
import type { HelperSession } from '../web/useHelperSessions.js';
import {
  helperNavigationLists,
  helperNavigationOrder,
  listedHelperSessions,
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
  it('searches and name-sorts an untitled conversation by the name it is shown with', () => {
    const untitled = [...sessions, session('blank', '', 'p1', '2026-10-29T01:00:00Z')];
    const names = helperNavigationLists(untitled, projects, '', { sort: 'name', order: [] });
    expect(names.inProject('p1').map((item) => item.id)).toEqual(['one', 'two', 'blank']);
    const found = helperNavigationLists(untitled, projects, '새 도우미', {
      sort: 'recent',
      order: [],
    });
    expect(found.recent.map((item) => item.id)).toEqual(['blank']);
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
  it('lists an unused conversation of another scope only once it was opened in this tab', () => {
    const elsewhere = { kind: 'chat', chatId: 'other' } as const;
    const values = [
      sessions[0],
      { ...session('here', '새 도우미 대화', null, '2026-10-29T01:00:00Z'), unused: true as const },
      {
        ...session('there', '새 도우미 대화', null, '2026-10-29T01:00:00Z'),
        scope: elsewhere,
        unused: true as const,
      },
    ];
    const listed = (opened: string[]) =>
      listedHelperSessions(values, sessions[0].scope, new Set(opened)).map((item) => item.id);
    expect(listed([])).toEqual(['one', 'here']);
    expect(listed(['there'])).toEqual(['one', 'here', 'there']);
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
});
