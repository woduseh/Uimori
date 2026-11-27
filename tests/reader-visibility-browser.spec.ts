import { expect, test, type Page } from './fixtures/browser-test.js';
import { readerRefreshDelay } from '../web/reader-sync.js';
import { trackPageFetches } from './fixtures/page-fetches.js';
import { createReadingChat } from './fixtures/personal-workspace.js';
import { navigationAction } from './ui-navigation.js';

type ObservedWindow = Window & { readerVisibilityEvents: string[] };

async function observeStream(page: Page) {
  await page.addInitScript(() => {
    Object.assign(window, { readerVisibilityEvents: [] });
    const Original = window.EventSource;
    window.EventSource = class extends Original {
      private notify = (event: Event) => {
        this.dispatchEvent(
          new MessageEvent('message', { data: JSON.stringify((event as CustomEvent).detail) })
        );
      };
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        this.addEventListener('message', (event) => {
          (window as unknown as ObservedWindow).readerVisibilityEvents.push(
            JSON.parse(event.data).kind
          );
        });
        window.addEventListener('test-reader-notification', this.notify);
      }
      close() {
        window.removeEventListener('test-reader-notification', this.notify);
        super.close();
      }
    };
  });
}

async function hidden(page: Page, value: boolean) {
  await page.evaluate((value) => {
    if (value) Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    else delete (document as unknown as { hidden?: boolean }).hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  }, value);
}

test('READVIS01 hidden and library readers defer SSE refreshes and restore current text with the draft', async ({
  page,
  request,
}) => {
  const { chat, detail } = await createReadingChat(request, 'Reader visibility', 1);
  const source = detail.sources[0];
  await observeStream(page);
  const readerFetches = await trackPageFetches(
    page,
    new RegExp(`^/api/chats/${chat.id}/reader$`, 'u')
  );
  const readerSettled = () =>
    expect
      .poll(async () => {
        await page.clock.runFor(readerRefreshDelay);
        return readerFetches.inFlight();
      })
      .toBe(0);
  await page.clock.install();
  await page.goto(`/?chat=${chat.id}&source=${source.id}&mode=original`);
  const manuscript = page.locator('.risu-message-surface');
  await expect(manuscript).toContainText('Scene 1. Mira carried a purple umbrella.');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as ObservedWindow).readerVisibilityEvents))
    .toContain('snapshot');
  await readerSettled();
  const draft = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
  await draft.fill('화면을 떠나도 보존할 다음 장면 초안');

  let revision = source.editRevision ?? 0;
  let edits = 0;
  const editElsewhere = async (text: string) => {
    const response = await request.put(`/api/sources/${source.id}/text`, {
      data: { text, expectedRevision: revision },
    });
    expect(response.ok(), await response.text()).toBe(true);
    revision = (await response.json()).editRevision;
    edits++;
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as ObservedWindow).readerVisibilityEvents.filter(
              (kind) => kind === 'source.edited'
            ).length
        )
      )
      .toBe(edits);
  };

  await hidden(page, true);
  const hiddenReads = await readerFetches.count();
  await editElsewhere('원고 화면이 숨겨진 동안 다른 기기에서 저장한 본문.');
  await page.clock.runFor(readerRefreshDelay);
  expect(await readerFetches.count()).toBe(hiddenReads);
  await expect(manuscript).toContainText('Scene 1. Mira carried a purple umbrella.');
  await hidden(page, false);
  await expect(manuscript).toHaveText('원고 화면이 숨겨진 동안 다른 기기에서 저장한 본문.');
  await expect(draft).toHaveValue('화면을 떠나도 보존할 다음 장면 초안');
  await expect.poll(() => readerFetches.inFlight()).toBe(0);

  await navigationAction(page, '서재');
  await expect(page.getByTestId('library-panel')).toBeVisible();
  const libraryReads = await readerFetches.count();
  await editElsewhere('서재를 보는 동안 다른 기기에서 다시 저장한 본문.');
  await page.clock.runFor(readerRefreshDelay);
  expect(await readerFetches.count()).toBe(libraryReads);
  await page.goBack();
  await expect(manuscript).toHaveText('서재를 보는 동안 다른 기기에서 다시 저장한 본문.');
  await expect(draft).toHaveValue('화면을 떠나도 보존할 다음 장면 초안');
  expect(await readerFetches.count()).toBeGreaterThan(libraryReads);

  await readerSettled();
  await navigationAction(page, '서재');
  let held = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `**/api/chats/${chat.id}/reader?*`,
    async (route) => {
      const response = await route.fetch();
      held = true;
      await gate;
      await route.fulfill({ response });
    },
    { times: 1 }
  );
  try {
    await page.goBack();
    await expect.poll(() => held).toBe(true);
    await hidden(page, true);
    release();
    await expect.poll(() => readerFetches.inFlight()).toBe(0);
    const discardedReadCount = await readerFetches.count();
    await hidden(page, false);
    await expect.poll(() => readerFetches.count()).toBeGreaterThan(discardedReadCount);
    await expect(draft).toHaveValue('화면을 떠나도 보존할 다음 장면 초안');
  } finally {
    release();
  }
});
