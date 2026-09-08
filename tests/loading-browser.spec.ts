import { editLibraryContent, openSourceActions } from './ui-navigation.js';
import { postFixtureChat } from './fixtures/chat.js';
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Chat, ChatDetail, ReaderDetail, ReaderRun, Run } from '../core/types.js';
import type { Content } from '../core/product.js';
import { navigationAction } from './ui-navigation.js';

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
    data: { ...chat.settings, translation: false, status: false, expectedSettingsRevision: 1 },
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
async function navLibrary(page: Page) {
  await navigationAction(page, '봇');
}
async function openActivity(container: Locator) {
  const activity = container.getByTestId('turn-activity');
  await expect(activity).toBeVisible();
  if ((await activity.getAttribute('open')) === null)
    await activity.locator('summary').first().click();
  return activity;
}

test('LOADUI06 scene navigator jumps across bounded pages and remains usable in focus and mobile reading', async ({
  page,
  request,
}, info) => {
  const seeded = await seed(request, 12);
  const ids = seeded.sources.map((source) => source.id);
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method()))
      writes.push(`${request.method()} ${request.url()}`);
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/?chat=${seeded.chat.id}`);
  const navigator = page.getByRole('navigation', { name: '장면 탐색', exact: true });
  const list = page.getByRole('dialog', { name: '장면 목록', exact: true });
  await expect(navigator).toBeVisible();
  await expect(navigator).toContainText('1 / 12');
  await navigator.getByRole('button', { name: '장면 목록 열기', exact: true }).click();
  await expect(list.getByRole('button', { name: /번째 장면 ·/ })).toHaveCount(12);
  await list.getByRole('button', { name: /^8번째 장면 · Synthetic page 8\./ }).click();
  await expect(list).toHaveCount(0);
  await expect(articles(page)).toHaveCount(5);
  await expect(article(page, ids[7])).toBeVisible();
  await expect(article(page, ids[0])).toHaveCount(0);
  await expect(navigator).toContainText('8 / 12');
  await expect(page).toHaveURL(new RegExp(`source=${ids[7]}`));
  const currentMark = navigator.getByRole('button', { name: /^8번째 장면 ·/ });
  await expect(currentMark).toBeVisible();
  await expect(currentMark).toHaveAttribute('aria-current', 'location');
  await currentMark.hover();
  await expect(currentMark.locator('.scene-preview')).toBeVisible();
  await page.screenshot({ path: info.outputPath('scene-navigator-desktop.png') });

  await navigator.getByRole('button', { name: '최신 장면으로', exact: true }).click();
  await expect(article(page, ids[11])).toBeVisible();
  await expect(articles(page)).toHaveCount(2);
  await expect(navigator).toContainText('12 / 12');
  await page.goBack();
  await expect(article(page, ids[7])).toBeVisible();
  await expect(navigator).toContainText('8 / 12');

  await page.getByRole('button', { name: '집중 읽기', exact: true }).click();
  await expect(navigator).toBeVisible();
  await expect(currentMark).toBeVisible();
  await navigator.getByRole('button', { name: '장면 목록 열기', exact: true }).click();
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(
    navigator.getByRole('button', { name: '장면 목록 열기', exact: true })
  ).toBeFocused();
  await page.getByRole('button', { name: '집중 읽기 종료', exact: true }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(navigator).toBeVisible();
  await navigator.getByRole('button', { name: '장면 목록 열기', exact: true }).click();
  const choice = list.getByRole('button', { name: /^3번째 장면 · Synthetic page 3\./ });
  await expect(choice).toBeVisible();
  for (const control of [list, choice]) {
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(await control.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true
    );
  }
  await page.screenshot({ path: info.outputPath('scene-navigator-mobile.png') });
  await choice.click();
  await expect(list).toHaveCount(0);
  await expect(article(page, ids[2])).toBeVisible();
  await expect(navigator).toContainText('3 / 12');
  await expect(articles(page)).toHaveCount(5);
  const after = await detail(request, seeded.chat.id);
  expect(after.sources).toEqual(seeded.sources);
  expect(after.runs).toEqual(seeded.runs);
  expect(after.attempts).toEqual(seeded.attempts);
  expect(writes).toHaveLength(0);
});

test('LOADUI01 bounded pages, previous/next, deep links and reload preserve reader position', async ({
  page,
  context,
  request,
}, info) => {
  const seeded = await seed(request, 12);
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
  const reader = page.locator('[data-reader-scrollport]');
  const target = article(page, ids[6]).locator('[data-block-anchor]').first();
  await target.evaluate((element) => {
    const viewport = element.closest<HTMLElement>('[data-reader-scrollport]')!;
    viewport.scrollTop +=
      element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 24;
  });
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const record = Object.keys(sessionStorage).find((key) => key.startsWith('reading:'));
        return record ? JSON.parse(sessionStorage.getItem(record)!).source : '';
      })
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
  await page.screenshot({ path: info.outputPath('loading-reader-page.png') });
  const deep = await context.newPage();
  await deep.goto(`/?chat=${seeded.chat.id}&source=${ids[10]}`);
  await expect(article(deep, ids[10])).toBeVisible();
  await expect(articles(deep)).toHaveCount(2);
  expect(requests.some((url) => /\/api\/chats\/[^/?]+(?:\?|$)/.test(url))).toBe(false);
  expect(requests.some((url) => url.includes('/reader?'))).toBe(true);
  const after = await detail(request, seeded.chat.id);
  expect(after.runs).toEqual(seeded.runs);
  expect(after.attempts).toEqual(seeded.attempts);
  await deep.close();
});

test('LOADUI02 same-source tabs keep CAS drafts and isolate another chat, manual translation stays local', async ({
  page,
  context,
  request,
}, info) => {
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
    await openSourceActions(article(tab, source.id));
    await article(tab, source.id).getByRole('button', { name: '원문 수정', exact: true }).click();
  }
  await second.getByLabel('원문 수정 내용').fill('Stale tab draft must survive.');
  await third.getByLabel('다음 장면 요청').fill('Other chat draft stays here.');
  await page.getByLabel('원문 수정 내용').fill('Accepted source revision from first tab.');
  await page.getByRole('button', { name: '원문 저장', exact: true }).click();
  await expect(page.getByLabel('원문 수정 내용')).toHaveCount(0);
  await expect(second.getByRole('alert')).toContainText('편집 중 저장된 내용이 바뀌었어요');
  await expect(second.getByLabel('원문 수정 내용')).toHaveValue('Stale tab draft must survive.');
  await expect(second.getByRole('button', { name: '원문 저장', exact: true })).toBeDisabled();
  const rejected = await request.put(`/api/sources/${source.id}/text`, {
    data: { text: 'Stale CAS overwrite', expectedRevision: 0 },
  });
  expect(rejected.status()).toBe(409);
  await expect(third.getByLabel('다음 장면 요청')).toHaveValue('Other chat draft stays here.');
  expect((await detail(request, other.chat.id)).sources).toEqual(other.sources);
  await openSourceActions(article(page, source.id));
  await article(page, source.id).getByRole('button', { name: '번역 수정', exact: true }).click();
  await page.getByLabel('번역 수정 내용').fill('직접 저장한 합성 번역이에요.');
  await page.getByRole('button', { name: '번역 저장', exact: true }).click();
  await expect(article(page, source.id).getByTestId('translation-text')).toContainText(
    '직접 저장한 합성 번역이에요.'
  );
  const after = await detail(request, seeded.chat.id);
  expect(after.sources[0].editRevision).toBe(1);
  expect(after.sources[0].text).toBe('Accepted source revision from first tab.');
  expect(after.runs).toEqual(seeded.runs);
  expect(after.attempts).toEqual(seeded.attempts);
  await second.screenshot({ path: info.outputPath('loading-cas.png') });
  await second.close();
  await third.close();
});

test('LOADUI03 large library uses summaries then fetches current content on click', async ({
  page,
  request,
}, info) => {
  const prefix = `Loading library ${Date.now()}`;
  let first!: Content;
  for (let index = 0; index < 100; index++) {
    const response = await request.post('/api/content', {
      data: {
        kind: 'bot',
        title: `${prefix} ${String(index).padStart(3, '0')}`,
        description: 'Synthetic summary',
        text: `Revision one ${index}: ` + 'Synthetic character document. '.repeat(300),
        loading: 'pinned',
        relatedIds: [],
      },
    });
    expect(response.ok()).toBeTruthy();
    if (!index) first = (await response.json()) as Content;
  }
  const revisionRequests: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'GET' && /\/api\/content\/[^/?]+$/.test(request.url()))
      revisionRequests.push(request.url());
  });
  const summaryResponse = page.waitForResponse((response) =>
    response.url().includes('/api/library?')
  );
  await page.goto('/');
  const summaries = await (await summaryResponse).json();
  expect(summaries.contentBodiesOmitted).toBe(true);
  expect(
    summaries.contents.filter((item: Content) => item.title.startsWith(`${prefix} `))
  ).toHaveLength(100);
  expect(summaries.contents.every((item: Record<string, unknown>) => item.text === '')).toBe(true);
  expect(JSON.stringify(summaries)).not.toContain('Synthetic character document.');
  expect(JSON.stringify(summaries)).not.toContain(first.text);
  await navLibrary(page);
  await expect(page.getByTestId('library-panel')).toBeVisible();
  expect(revisionRequests).toHaveLength(0);
  const update = await request.put(`/api/content/${first.id}`, {
    data: {
      kind: first.kind,
      title: first.title,
      description: first.description,
      text: 'Current content replaces the earlier library summary on open.',
      loading: first.loading,
      relatedIds: first.relatedIds,
      expectedRevision: 1,
    },
  });
  expect(update.ok()).toBeTruthy();
  await editLibraryContent(page, `${first.title}`);
  await expect(page.getByLabel('자료 본문')).toHaveValue(
    'Current content replaces the earlier library summary on open.'
  );
  expect(revisionRequests).toHaveLength(1);
  expect(revisionRequests[0]).toContain(`/content/${first.id}`);
  await page.screenshot({ path: info.outputPath('loading-library.png') });
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
  await expect(page.getByText('연결을 다시 확인하는 중이에요.', { exact: true })).toHaveCount(0);
  await context.setOffline(true);
  try {
    await expect(page.getByText('연결을 다시 확인하는 중이에요.', { exact: true })).toBeVisible();
    const edit = await request.put(`/api/sources/${first.id}/text`, {
      data: { text: 'Source changed while browser was offline.', expectedRevision: 0 },
    });
    expect(edit.ok()).toBeTruthy();
    await expect(article(page, first.id).getByTestId('source-text')).not.toContainText(
      'Source changed while browser was offline.'
    );
  } finally {
    await context.setOffline(false);
  }
  await expect(article(page, first.id).getByTestId('source-text')).toContainText(
    'Source changed while browser was offline.'
  );
  await expect(page.getByText('연결을 다시 확인하는 중이에요.', { exact: true })).toHaveCount(0);
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
  expect(after.runs).toEqual(seeded.runs);
  expect(after.attempts).toEqual(seeded.attempts);
  expect(generated).toHaveLength(0);
  await page.screenshot({ path: info.outputPath('loading-reconnected.png') });
});

test('LOADUI05 context summary status fits mobile reader and run details without changing source or dispatching requests', async ({
  page,
  request,
}, info) => {
  const seeded = await seed(request, 1);
  const source = seeded.sources[0];
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method()))
      writes.push(`${request.method()} ${request.url()}`);
  });
  let stage: 'pending' | 'ready' | 'failed' | 'unknown' = 'pending';
  const summary = (): NonNullable<ReaderRun['contextSummary']> => ({
    status: stage === 'unknown' ? 'ready' : stage,
    inputTokenLimit: 272000,
    estimatedInputTokens: stage === 'pending' || stage === 'unknown' ? null : 248600,
    compactedSources: stage === 'pending' ? 0 : 12,
    summaryCalls: stage === 'pending' ? 0 : 2,
    error:
      stage === 'failed'
        ? '필수 지침과 최신 원문만으로 입력 컨텍스트 한도를 넘었어요. 입력 한도를 높이거나 자료를 줄여 주세요.'
        : null,
  });
  await page.route(`**/api/chats/${seeded.chat.id}/reader?*`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as ReaderDetail;
    const base = body.runs.find((run) => run.id === source.runId)!;
    body.runs = body.runs.map((run) => ({
      ...run,
      contextSummary: stage === 'ready' || stage === 'unknown' ? summary() : undefined,
    }));
    if (stage === 'pending' || stage === 'failed')
      body.runs.push({
        ...base,
        id: `${base.id}-context-status-fixture`,
        request: 'Synthetic context status preview',
        status: stage === 'pending' ? 'running' : 'failed',
        sourceRevision: null,
        partialText: undefined,
        error: null,
        contextSummary: summary(),
      });
    await route.fulfill({ response, json: body });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?chat=${seeded.chat.id}`);
  await openActivity(page.getByTestId('pending-run'));
  const pending = page.getByTestId('pending-run').getByTestId('context-summary');
  await expect(pending).toHaveAttribute('data-context-status', 'pending');
  await expect(pending).toHaveText('컨텍스트 확인 중');

  stage = 'ready';
  await page.reload();
  const activity = await openActivity(article(page, source.id));
  const ready = article(page, source.id).getByTestId('context-summary');
  await expect(ready).toHaveText('앞선 12개 원문 요약 · 입력 약 248,600 / 272,000 토큰 · 요약 2회');
  await ready.scrollIntoViewIfNeeded();
  const bounds = await ready.boundingBox();
  expect(bounds).not.toBeNull();
  const heading = await activity.locator('.task-heading').boundingBox();
  expect(heading).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(heading!.y + heading!.height);
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await ready.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('context-summary-mobile.png') });
  await expect(activity.locator('.run-task-details').getByTestId('context-summary')).toHaveText(
    '앞선 12개 원문 요약 · 입력 약 248,600 / 272,000 토큰 · 요약 2회'
  );

  stage = 'failed';
  await page.reload();
  await openActivity(page.getByTestId('pending-run'));
  const failed = page.getByTestId('pending-run').getByTestId('context-summary');
  await expect(failed).toHaveAttribute('role', 'alert');
  await expect(failed).toContainText('컨텍스트 확인에 실패했어요.');
  await expect(failed).toContainText('필수 지침과 최신 원문만으로 입력 컨텍스트 한도를 넘었어요.');

  stage = 'unknown';
  await page.reload();
  await openActivity(article(page, source.id));
  await expect(article(page, source.id).getByTestId('context-summary')).toContainText(
    '입력 추정치 미확인'
  );
  await expect(article(page, source.id).getByTestId('source-text')).toBeAttached();
  const after = await detail(request, seeded.chat.id);
  expect(after.sources).toEqual(seeded.sources);
  expect(after.runs).toEqual(seeded.runs);
  expect(after.attempts).toEqual(seeded.attempts);
  expect(writes).toHaveLength(0);
});

test('LOADUI07 synthetic navigation metadata covers long-list paging, search and visible-source tracking', async ({
  page,
  request,
}) => {
  const seeded = await seed(request, 2);
  const ids = seeded.sources.map((source) => source.id);
  // Only two real fixture sources are stored. Extra index entries exercise list rendering,
  // not server paging or navigation to nonexistent source bodies.
  await page.route(`**/api/chats/${seeded.chat.id}/reader?*`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as ReaderDetail;
    body.reader.navigation = [
      ...body.reader.navigation,
      ...Array.from({ length: 63 }, (_, index) => ({
        id: `synthetic-navigation-${index + 3}`,
        number: index + 3,
        label: `Synthetic navigator ${index + 3}`,
      })),
    ];
    await route.fulfill({ response, json: body });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/?chat=${seeded.chat.id}`);
  const navigator = page.getByRole('navigation', { name: '장면 탐색', exact: true });
  const list = page.getByRole('dialog', { name: '장면 목록', exact: true });
  await expect(navigator).toContainText('1 / 65');
  await navigator.getByRole('button', { name: '장면 목록 열기', exact: true }).click();
  await expect(list.getByRole('button', { name: /번째 장면 ·/ })).toHaveCount(60);
  await list.getByRole('button', { name: '다음 목록', exact: true }).click();
  const nextFirst = list.getByRole('button', {
    name: '61번째 장면 · Synthetic navigator 61',
    exact: true,
  });
  await expect(nextFirst).toBeFocused();
  await expect(nextFirst).toBeInViewport();
  await expect(list.getByRole('button', { name: /번째 장면 ·/ })).toHaveCount(5);
  await expect(list.getByRole('button', { name: '다음 목록', exact: true })).toBeDisabled();
  await list.getByRole('button', { name: '이전 목록', exact: true }).click();
  await expect(list.getByRole('button', { name: /^1번째 장면 ·/ })).toBeFocused();
  const search = list.getByRole('searchbox', { name: '장면 번호 또는 요청으로 찾기' });
  await search.fill('65');
  await expect(list.getByRole('button', { name: /번째 장면 ·/ })).toHaveCount(1);
  await expect(
    list.getByRole('button', { name: '65번째 장면 · Synthetic navigator 65', exact: true })
  ).toBeVisible();
  await search.fill('Synthetic page 2.');
  await expect(list.getByRole('button', { name: /번째 장면 ·/ })).toHaveCount(1);
  await list.getByRole('button', { name: /^2번째 장면 · Synthetic page 2\./ }).click();
  await expect(navigator).toContainText('2 / 65');
  await expect(navigator.getByRole('button', { name: /^2번째 장면 ·/ })).toHaveAttribute(
    'aria-current',
    'location'
  );
  await navigator.getByRole('button', { name: /^1번째 장면 ·/ }).click();
  await expect(navigator).toContainText('1 / 65');
  await article(page, ids[1]).evaluate((element) => {
    const viewport = element.closest<HTMLElement>('[data-reader-scrollport]')!;
    viewport.scrollTop +=
      element.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  });
  await expect(navigator).toContainText('2 / 65');
  await expect(navigator.getByRole('button', { name: /^2번째 장면 ·/ })).toHaveAttribute(
    'aria-current',
    'location'
  );
  await expect(articles(page)).toHaveCount(2);
  const after = await detail(request, seeded.chat.id);
  expect(after.sources).toEqual(seeded.sources);
  expect(after.runs).toEqual(seeded.runs);
  expect(after.attempts).toEqual(seeded.attempts);
});
