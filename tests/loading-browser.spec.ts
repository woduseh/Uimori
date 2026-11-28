import { MOBILE_WIDTH, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { visualReview } from './fixtures/visual-review.js';
import { postFixtureChat } from './fixtures/chat.js';
import { waitForNativeLayout } from './fixtures/native-message.js';
import { test, expect, type APIRequestContext, type Page } from './fixtures/browser-test.js';
import type { Chat, ChatDetail, Run } from '../core/types.js';

test.setTimeout(120000);
async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${id}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function seed(request: APIRequestContext, count: number) {
  const response = await postFixtureChat(request, {
    data: { title: `Loading synthetic ${Date.now()}` },
  });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as Chat;
  const settings = await request.patch(`/api/chats/${chat.id}/settings`, {
    data: { ...chat.settings, expectedSettingsRevision: 1 },
  });
  expect(settings.ok()).toBeTruthy();
  for (let index = 0; index < count; index++) {
    const before = await detail(request, chat.id);
    const response = await request.post(`/api/chats/${chat.id}/runs`, {
      data: {
        request:
          `Synthetic page ${index + 1}.\n\n` +
          'The lantern marks a safe crossing over the river. This is synthetic public test prose.\n\n'.repeat(
            20
          ),
        expectedRevision: before.chat.headRevision,
        expectedSettingsRevision: before.chat.settingsRevision,
        idempotencyKey: `loading-${chat.id}-${index}`,
      },
    });
    expect(response.ok()).toBeTruthy();
    const run = (await response.json()) as Run;
    await expect
      .poll(
        async () => (await detail(request, chat.id)).runs.find((item) => item.id === run.id)?.status
      )
      .toBe('completed');
  }
  return detail(request, chat.id);
}
const articles = (page: Page) => page.getByTestId('source');
const article = (page: Page, id: string) =>
  page.locator(`[data-testid="source"][data-source-id="${id}"]`);
async function settledNativeSources(page: Page, ids: string[]) {
  await Promise.all(
    ids.map(async (id) => {
      const container = article(page, id).getByTestId('source-text');
      await expect(container.locator('.risu-message-content')).toContainText(
        'The lantern marks a safe crossing over the river.'
      );
      await waitForNativeLayout(container);
    })
  );
}

test('LOADUI09 newer chat list wins over a late empty response without clearing the selected chat', async ({
  page,
  request,
}) => {
  const seeded = await seed(request, 1);
  let listRequests = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/chats', async (route) => {
    if (route.request().method() !== 'GET' || ++listRequests !== 1) return route.continue();
    await held;
    await route.fulfill({ json: [] });
  });
  await page.route(
    (url) => url.pathname === '/api/events' && url.searchParams.get('chat') === seeded.chat.id,
    (route) =>
      route.fulfill({ contentType: 'text/event-stream', body: 'data: {"kind":"chat.deleted"}\n\n' })
  );
  try {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await page.goto(`/?chat=${seeded.chat.id}`);
    const chat = page.locator(`.bot-chat-item[data-chat-id="${seeded.chat.id}"]`);
    await expect(chat).toBeVisible();
    await expect(article(page, seeded.sources[0].id)).toBeVisible();
    expect(listRequests).toBeGreaterThanOrEqual(2);
    const finished = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/chats' && response.ok()
    );
    release();
    await finished;
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    await expect(chat).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`chat=${seeded.chat.id}`));
    await expect(article(page, seeded.sources[0].id)).toBeVisible();
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('LOADUI10 reader refresh preserves the upper reading position when latest text grows', async ({
  page,
  request,
}) => {
  const seeded = await seed(request, 1);
  const source = seeded.sources[0];
  {
    const width = MOBILE_WIDTH;
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?chat=${seeded.chat.id}`);
    const text = article(page, source.id).getByTestId('source-text');
    await expect(text).toBeVisible();
    const reader = page.locator('[data-reader-scrollport]');
    await reader.evaluate((node) => {
      node.scrollTop = 160;
    });
    const before = await reader.evaluate((node) => ({
      top: node.scrollTop,
      height: node.scrollHeight,
    }));
    const current = (await detail(request, seeded.chat.id)).sources[0];
    const changed = await request.put(`/api/sources/${source.id}/text`, {
      data: {
        text: `${current.text}\n\n${'Synthetic appended text below the current reading position.\n\n'.repeat(20)}APPENDED_${width}`,
        expectedRevision: current.editRevision ?? 0,
      },
    });
    expect(changed.ok()).toBeTruthy();
    await expect(text).toContainText(`APPENDED_${width}`);
    await expect
      .poll(() => reader.evaluate((node) => node.scrollHeight))
      .toBeGreaterThan(before.height);
    expect(Math.abs((await reader.evaluate((node) => node.scrollTop)) - before.top)).toBeLessThan(
      3
    );
    const latest = page.getByRole('button', { name: '본문 맨 아래로', exact: true });
    await expect(latest).toBeEnabled();
    await latest.click();
    await expect
      .poll(() => reader.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop))
      .toBeLessThanOrEqual(2);
  }
  const after = await detail(request, seeded.chat.id);
  expect(
    after.runs.map(({ id, request, sourceRevision }) => ({ id, request, sourceRevision }))
  ).toEqual(
    seeded.runs.map(({ id, request, sourceRevision }) => ({ id, request, sourceRevision }))
  );
  expect(after.attempts).toEqual(seeded.attempts);
});

test('LOADUI01 bounded pages, previous/next, deep links and reload preserve reader position', async ({
  page,
  context,
  request,
}, info) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  const seeded = await seed(request, 12);
  const emptyResponse = await request.post('/api/chats', {
    data: { title: 'Empty reentry destination', botId: seeded.chat.botId },
  });
  expect(emptyResponse.ok()).toBe(true);
  const empty = (await emptyResponse.json()) as Chat;
  const ids = seeded.sources.map((source) => source.id);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(`/?chat=${seeded.chat.id}`);
  await expect(articles(page)).toHaveCount(5);
  const pager = page.getByRole('navigation', { name: '원고 구간', exact: true });
  await expect(pager).toContainText('1–5 / 12');
  await expect(pager.getByRole('button', { name: '이전 원고' })).toBeDisabled();
  await pager.getByRole('button', { name: '다음 원고' }).click();
  await expect(pager).toContainText('6–10 / 12');
  await expect(articles(page)).toHaveCount(5);
  await expect(article(page, ids[5])).toBeAttached();
  await expect(article(page, ids[0])).toHaveCount(0);
  await pager.getByRole('button', { name: '다음 원고' }).click();
  await expect(pager).toContainText('11–12 / 12');
  await expect(articles(page)).toHaveCount(2);
  await expect(pager.getByRole('button', { name: '다음 원고' })).toBeDisabled();
  await pager.getByRole('button', { name: '이전 원고' }).click();
  await expect(pager).toContainText('6–10 / 12');
  await settledNativeSources(page, ids.slice(5, 10));
  const reader = page.locator('[data-reader-scrollport]');
  const target = article(page, ids[6]).locator('[data-block-anchor]').first();
  await target.evaluate((element) => {
    const viewport = element.closest<HTMLElement>('[data-reader-scrollport]')!;
    viewport.scrollTop +=
      element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 24;
  });
  await expect
    .poll(async () =>
      page.evaluate((chatId) => {
        const key = `reading:${chatId}`;
        const record = localStorage.getItem(key) ?? sessionStorage.getItem(key);
        return record ? JSON.parse(record).source : '';
      }, seeded.chat.id)
    )
    .toBe(ids[6]);
  const before = await target.evaluate(
    (element) =>
      element.getBoundingClientRect().top -
      element.closest('[data-reader-scrollport]')!.getBoundingClientRect().top
  );
  await page.reload();
  await expect(article(page, ids[6])).toBeAttached();
  await expect
    .poll(async () =>
      Math.abs(
        (await article(page, ids[6])
          .locator('[data-block-anchor]')
          .first()
          .evaluate(
            (element) =>
              element.getBoundingClientRect().top -
              element.closest('[data-reader-scrollport]')!.getBoundingClientRect().top
          )) - before
      )
    )
    .toBeLessThan(4);
  await expect(articles(page)).toHaveCount(5);
  await expect(reader).toBeVisible();
  await settledNativeSources(page, ids.slice(5, 10));
  await page.locator(`[data-chat-id="${empty.id}"] .chat-link`).click();
  await expect(
    page.getByRole('heading', { name: '첫 장면을 들려주세요.', exact: true })
  ).toBeVisible();
  const presentations: string[] = [];
  let recording = true;
  page.on('request', (event) => {
    const path = new URL(event.url()).pathname;
    if (
      recording &&
      path.startsWith(`/api/chats/${seeded.chat.id}/sources/`) &&
      path.endsWith('/presentation')
    )
      presentations.push(path.split('/').at(-2)!);
  });
  await page.locator(`[data-chat-id="${seeded.chat.id}"] .chat-link`).click();
  await expect(pager).toContainText('6–10 / 12');
  await settledNativeSources(page, ids.slice(5, 10));
  for (const id of ids.slice(5, 10))
    await expect(article(page, id).getByTestId('source-text')).toContainText(
      'Mira waited beside the rail, leaving the next decision to her companion.'
    );
  await expect
    .poll(async () =>
      Math.abs(
        (await target.evaluate(
          (element) =>
            element.getBoundingClientRect().top -
            element.closest('[data-reader-scrollport]')!.getBoundingClientRect().top
        )) - before
      )
    )
    .toBeLessThan(4);
  recording = false;
  expect(presentations.filter((id) => ids.slice(0, 5).includes(id))).toEqual([]);
  expect([...presentations].sort()).toEqual(ids.slice(5, 10).sort());
  if (visualReview) await page.screenshot({ path: info.outputPath('loading-reader-page.png') });
  const deep = await context.newPage();
  await deep.goto(`/?chat=${seeded.chat.id}&source=${ids[10]}`);
  await expect(article(deep, ids[10])).toBeVisible();
  await expect(articles(deep)).toHaveCount(2);
  expect(requests.some((url) => /\/api\/chats\/[^/?]+(?:\?|$)/.test(url))).toBe(false);
  expect(requests.some((url) => url.includes('/reader?'))).toBe(true);
  const after = await detail(request, seeded.chat.id);
  expect(
    after.runs.map(({ id, request, sourceRevision }) => ({ id, request, sourceRevision }))
  ).toEqual(
    seeded.runs.map(({ id, request, sourceRevision }) => ({ id, request, sourceRevision }))
  );
  expect(after.attempts).toEqual(seeded.attempts);
  await deep.close();
});

test('LOADUI02 same-source tabs keep CAS drafts and isolate another chat', async ({
  page,
  context,
  request,
}) => {
  const seeded = await seed(request, 1);
  const other = await seed(request, 1);
  const source = seeded.sources[0];
  const second = await context.newPage();
  const third = await context.newPage();
  await Promise.all([
    page.goto(`/?chat=${seeded.chat.id}`),
    second.goto(`/?chat=${seeded.chat.id}`),
    third.goto(`/?chat=${other.chat.id}`),
  ]);
  for (const tab of [page, second]) {
    await expect(article(tab, source.id)).toBeVisible();
    await article(tab, source.id).getByRole('button', { name: '원문 수정', exact: true }).click();
  }
  await second.getByLabel('원문 수정 내용').fill('Stale tab draft must survive.');
  await third.getByLabel('다음 장면 요청').fill('Other chat draft stays here.');
  await page.getByLabel('원문 수정 내용').fill('Accepted source revision from first tab.');
  await page.getByRole('button', { name: '원문 저장', exact: true }).click();
  await expect(page.getByLabel('원문 수정 내용')).toHaveCount(0);
  await expect(second.getByRole('alert')).toContainText('편집 중 저장된 내용이 바뀌었어요');
  await expect(second.getByLabel('원문 수정 내용')).toHaveValue('Stale tab draft must survive.');
  await second.getByRole('button', { name: '원문 저장', exact: true }).click();
  const sourceConflict = second.getByRole('alertdialog', { name: '원문 저장 충돌', exact: true });
  await expect(sourceConflict).toBeVisible();
  await expect(
    sourceConflict.getByText('Accepted source revision from first tab.', { exact: true })
  ).toBeVisible();
  await second.keyboard.press('Escape');
  await expect(sourceConflict).not.toBeVisible();
  await expect(second.getByLabel('원문 수정 내용')).toHaveValue('Stale tab draft must survive.');
  const rejected = await request.put(`/api/sources/${source.id}/text`, {
    data: { text: 'Stale CAS overwrite', expectedRevision: 0 },
  });
  expect(rejected.status()).toBe(409);
  await expect(third.getByLabel('다음 장면 요청')).toHaveValue('Other chat draft stays here.');
  expect((await detail(request, other.chat.id)).sources).toEqual(other.sources);
  const after = await detail(request, seeded.chat.id);
  expect(after.sources[0].editRevision).toBe(1);
  expect(after.sources[0].text).toBe('Accepted source revision from first tab.');
  expect(
    after.runs.map(({ id, request, sourceRevision }) => ({ id, request, sourceRevision }))
  ).toEqual(
    seeded.runs.map(({ id, request, sourceRevision }) => ({ id, request, sourceRevision }))
  );
  expect(after.attempts).toEqual(seeded.attempts);
  await second.close();
  await third.close();
});

test('LOADUI04 offline edits reappear on reconnect and connected SSE sends only the changed source', async ({
  page,
  context,
  request,
}, info) => {
  const seeded = await seed(request, 2);
  const [first, second] = seeded.sources;
  const generated: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/runs(?:\?|$)/.test(request.url()))
      generated.push(request.url());
  });
  await page.goto(`/?chat=${seeded.chat.id}`);
  await expect(articles(page)).toHaveCount(2);
  const reconnecting = page.getByRole('status').filter({ hasText: /연결을 다시 확인/ });
  await expect(reconnecting).toHaveCount(0);
  await context.setOffline(true);
  await expect(reconnecting).toBeVisible();
  const edit = await request.put(`/api/sources/${first.id}/text`, {
    data: { text: 'Source changed while browser was offline.', expectedRevision: 0 },
  });
  expect(edit.ok()).toBeTruthy();
  await expect(article(page, first.id).getByTestId('source-text')).not.toContainText(
    'Source changed while browser was offline.'
  );
  const catchUpResponse = page.waitForResponse(async (response) => {
    const url = new URL(response.url());
    if (
      !response.ok() ||
      url.pathname !== `/api/chats/${seeded.chat.id}/reader` ||
      url.searchParams.has('since')
    )
      return false;
    const body = await response.json();
    return body.sources.some(
      (source: { id: string; text: string }) =>
        source.id === first.id && source.text === 'Source changed while browser was offline.'
    );
  });
  await context.setOffline(false);
  await (await catchUpResponse).finished();
  await expect(article(page, first.id).getByTestId('source-text')).toContainText(
    'Source changed while browser was offline.'
  );
  await expect(reconnecting).toHaveCount(0);
  await expect(articles(page)).toHaveCount(2);
  const changedResponse = page.waitForResponse(async (response) => {
    if (
      !response.ok() ||
      !response.url().includes(`/chats/${seeded.chat.id}/reader?`) ||
      !new URL(response.url()).searchParams.has('since')
    )
      return false;
    const body = await response.json();
    return body.sources.some(
      (source: { id: string; text: string }) =>
        source.id === second.id &&
        source.text === 'Only the second source changed over connected SSE.'
    );
  });
  const nextEdit = await request.put(`/api/sources/${second.id}/text`, {
    data: { text: 'Only the second source changed over connected SSE.', expectedRevision: 0 },
  });
  expect(nextEdit.ok()).toBeTruthy();
  const delta = await (await changedResponse).json();
  expect(delta.sources.map((source: { id: string }) => source.id)).toEqual([second.id]);
  expect(delta.reader.order).toEqual([first.id, second.id]);
  await expect(article(page, second.id).getByTestId('source-text')).toContainText(
    'Only the second source changed over connected SSE.'
  );
  await expect(article(page, first.id).getByTestId('source-text')).toContainText(
    'Source changed while browser was offline.'
  );
  const after = await detail(request, seeded.chat.id);
  expect(
    after.runs.map(({ id, request, sourceRevision }) => ({ id, request, sourceRevision }))
  ).toEqual(
    seeded.runs.map(({ id, request, sourceRevision }) => ({ id, request, sourceRevision }))
  );
  expect(after.attempts).toEqual(seeded.attempts);
  expect(generated).toHaveLength(0);
  if (visualReview) await page.screenshot({ path: info.outputPath('loading-reconnected.png') });
});
