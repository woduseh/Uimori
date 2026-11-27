import { expect, test, type Page } from './fixtures/browser-test.js';
import { postFixtureChat } from './fixtures/chat.js';

type LiveWindow = Window & {
  liveSources: EventSource[];
  liveFrames: { event: string; kind?: string; chatId?: string | null }[];
};

const openSources = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as LiveWindow).liveSources
      .filter((source) => source.readyState !== EventSource.CLOSED)
      .map((source) => ({
        path: new URL(source.url).pathname,
        chat: new URL(source.url).searchParams.get('chat'),
        open: source.readyState === EventSource.OPEN,
      }))
  );

async function navigate(page: Page, search: string) {
  await page.evaluate((search) => {
    history.pushState(null, '', search);
    dispatchEvent(new PopStateEvent('popstate'));
  }, search);
}

test('LIVE01 a tab holds one event connection on the library screen and across chat switches', async ({
  page,
  request,
}) => {
  const first = await (await postFixtureChat(request, { data: { title: 'Live first' } })).json();
  const second = await (await postFixtureChat(request, { data: { title: 'Live second' } })).json();
  await page.addInitScript(() => {
    const observed = window as unknown as LiveWindow;
    observed.liveSources = [];
    observed.liveFrames = [];
    const Original = window.EventSource;
    window.EventSource = class extends Original {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        observed.liveSources.push(this);
        for (const event of ['live', 'chats'])
          this.addEventListener(event, (message) => {
            const data = JSON.parse((message as MessageEvent).data);
            observed.liveFrames.push({ event, kind: data.kind, chatId: data.chatId });
          });
      }
    };
  });
  const streams: string[] = [];
  page.on('request', (entry) => {
    const url = new URL(entry.url());
    if (url.pathname === '/api/events' || /^\/api\/chats\/[^/]+\/events$/u.test(url.pathname))
      streams.push(`${url.pathname}${url.search}`);
  });

  await page.goto('/');
  await expect
    .poll(() => openSources(page))
    .toEqual([{ path: '/api/events', chat: null, open: true }]);

  await navigate(page, `/?chat=${first.id}`);
  await expect
    .poll(() => openSources(page))
    .toEqual([{ path: '/api/events', chat: first.id, open: true }]);
  await navigate(page, `/?chat=${second.id}`);
  await expect
    .poll(() => openSources(page))
    .toEqual([{ path: '/api/events', chat: second.id, open: true }]);
  expect(streams.every((stream) => stream.startsWith('/api/events'))).toBe(true);
  expect(streams.filter((stream) => stream.includes(`chat=${second.id}`))).toHaveLength(1);

  const { titleRevision } = (await (await request.get(`/api/chats/${first.id}/reader`)).json())
    .chat;
  const renamed = await request.patch(`/api/chats/${first.id}/title`, {
    data: { title: 'Live first renamed', expectedTitleRevision: titleRevision },
  });
  expect(renamed.ok()).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as LiveWindow).liveFrames.filter((frame) => frame.event === 'chats')
      )
    )
    .toContainEqual({ event: 'chats', kind: 'chat.title.manual', chatId: first.id });
  expect(await openSources(page)).toHaveLength(1);
});
