import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test, vi } from 'vitest';
import type { Chat } from '../core/types.js';
import { ActivityNavigation } from '../web/ActivityNavigation.js';
import { HelperNavigation } from '../web/HelperNavigation.js';
import { helperNavigationStorageKey } from '../web/helper-navigation-model.js';
import type { HelperSession } from '../web/useHelperSessions.js';

afterEach(() => vi.unstubAllGlobals());

const runningSection = (html: string) => {
  const start = html.indexOf('data-activity-section="running"');
  const end = html.indexOf('data-activity-section=', start + 1);
  return html.slice(start, end < 0 ? undefined : end);
};

test('the running chat entry in the activity sidebar uses the rotating spinner', () => {
  const chat = { id: 'chat-1', title: '진행 대화', botId: 'bot-1' } as Chat;
  const html = renderToStaticMarkup(
    createElement(ActivityNavigation, {
      chats: [chat],
      library: null,
      selected: '',
      feed: { items: [], running: [{ chatId: chat.id, kind: 'main', count: 1 }] },
      error: '',
      onSelect: () => {},
      onChatsChanged: async () => {},
      onError: () => {},
      onAcknowledge: () => {},
      onInspect: () => {},
      onRetry: () => {},
    })
  );
  expect(runningSection(html)).toMatch(
    /<svg[^>]*class="[^"]*lucide-loader-circle[^"]*activity-spinner/u
  );
});

test('the running helper conversation in the activity sidebar uses the rotating spinner', () => {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) =>
      key === helperNavigationStorageKey ? JSON.stringify({ mode: 'activity' }) : null,
  });
  const session: HelperSession = {
    id: 'helper-1',
    title: '진행 도우미',
    projectId: null,
    revision: 0,
    scope: { kind: 'library', workId: 'workspace' },
    persona: '',
    limits: { totalCalls: 128, helperCalls: 128 },
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    lastActivityAt: '2026-10-01T00:00:00Z',
    activity: { running: 1, queued: 0 },
  };
  const html = renderToStaticMarkup(
    createElement(HelperNavigation, {
      sessions: [session],
      projects: [],
      currentId: '',
      unread: [],
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
  expect(runningSection(html)).toMatch(
    /<svg[^>]*class="[^"]*lucide-loader-circle[^"]*activity-spinner/u
  );
});
