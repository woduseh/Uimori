import { postFixtureChat } from './fixtures/chat.js';
import { visualReview } from './fixtures/visual-review.js';
import { DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Chat, ChatDetail, ReaderDetail, ReaderActivity, Run } from '../core/types.js';

test.setTimeout(60000);
const baseTime = new Date('2026-09-08T04:00:00.000Z');
const iso = (offset: number) => new Date(baseTime.getTime() + offset).toISOString();
function activity(
  id: string,
  kind: ReaderActivity['kind'] = 'main',
  status = 'running'
): ReaderActivity {
  return {
    id,
    kind,
    status,
    createdAt: iso(-12000),
    startedAt: iso(-12000),
    updatedAt: iso(0),
    finishedAt: status === 'running' ? null : iso(0),
    sourceRevision: null,
    generation: 1,
  };
}
async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${id}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function seed(request: APIRequestContext) {
  const response = await postFixtureChat(request, {
    data: { title: `Activity synthetic ${Date.now()}` },
  });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as Chat;
  expect(
    (
      await request.patch(`/api/chats/${chat.id}/settings`, {
        data: { ...chat.settings, expectedSettingsRevision: 1 },
      })
    ).ok()
  ).toBeTruthy();
  const before = await detail(request, chat.id);
  const created = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: 'A synthetic lantern lights the quiet river.',
      expectedRevision: before.chat.headRevision,
      expectedSettingsRevision: before.chat.settingsRevision,
      idempotencyKey: `activity-${chat.id}`,
    },
  });
  expect(created.ok()).toBeTruthy();
  const run = (await created.json()) as Run;
  await expect
    .poll(
      async () => (await detail(request, chat.id)).runs.find((item) => item.id === run.id)?.status
    )
    .toBe('completed');
  return detail(request, chat.id);
}
async function harness(
  page: Page,
  chatId: string,
  initial: ReaderActivity[],
  older: ReaderActivity[] = []
) {
  let items = initial,
    cursor = 1000000;
  let omittedRunIds: string[] = [];
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method()))
      writes.push(request.method() + ' ' + request.url());
  });
  await page.clock.install({ time: baseTime });
  await page.addInitScript(() => {
    class SyntheticStream extends EventTarget {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      closed = false;
      constructor() {
        super();
        setTimeout(() => this.onopen?.(), 0);
        window.addEventListener('test-activity-refresh', (event) => {
          if (!this.closed)
            this.onmessage?.({
              data: JSON.stringify({ kind: 'story.job', seq: (event as CustomEvent).detail }),
            });
        });
        window.addEventListener('test-activity-disconnect', () => {
          if (!this.closed) this.onerror?.();
        });
      }
      close() {
        this.closed = true;
      }
    }
    window.EventSource = SyntheticStream as unknown as typeof EventSource;
  });
  await page.route(`**/api/chats/${chatId}/reader?*`, async (route) => {
    const url = new URL(route.request().url());
    url.searchParams.delete('since');
    const response = await route.fetch({ url: url.toString() });
    expect(response.ok()).toBeTruthy();
    const body = (await response.json()) as ReaderDetail;
    body.reader.activity = items;
    body.runs = body.runs.filter((run) => !omittedRunIds.includes(run.id));
    body.reader.cursor = cursor;
    body.reader.activeJobs = items.filter((item) =>
      ['queued', 'running'].includes(item.status)
    ).length;
    await route.fulfill({ response, json: body });
  });
  const historyReads: string[] = [];
  await page.route(`**/api/chats/${chatId}/activities?*`, async (route) => {
    const before = new URL(route.request().url()).searchParams.get('before');
    historyReads.push(before ?? 'first');
    await route.fulfill({
      json: {
        items: before ? older : items,
        nextCursor: !before && older.length ? 'synthetic-older-page' : null,
      },
    });
  });
  await page.goto(`/?chat=${chatId}`);
  await expect(page.getByTestId('source')).toHaveCount(1);
  return {
    writes,
    historyReads,
    project(next: ReaderActivity[]) {
      items = next;
    },
    async set(next: ReaderActivity[], omitRuns: string[] = []) {
      items = next;
      omittedRunIds = omitRuns;
      cursor++;
      const response = page.waitForResponse(
        (response) => response.url().includes(`/chats/${chatId}/reader?`) && response.ok()
      );
      await page.evaluate(
        (seq) => window.dispatchEvent(new CustomEvent('test-activity-refresh', { detail: seq })),
        cursor
      );
      await response;
    },
  };
}

test('ACTUI06 old notification pages, bulk confirmation and execution identity survive reload', async ({
  page,
  request,
}, info) => {
  const seeded = await seed(request);
  const recent = Array.from({ length: 30 }, (_, index) =>
    activity(`recent-failure-${index}`, 'translation', 'failed')
  );
  const older = Array.from({ length: 12 }, (_, index) => ({
    ...activity(`older-failure-${index}`, 'translation', 'failed'),
    startedAt: iso(-60000 - index),
    createdAt: iso(-60000 - index),
  }));
  const uncertain: ReaderActivity = {
    ...activity('uncertain-job', 'translation', 'interrupted'),
    executionUncertain: true,
  };
  const running = activity('running-job', 'image');
  const state = await harness(page, seeded.chat.id, recent, older);
  await page.getByRole('button', { name: '작업 상세 보기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '작업 알림', exact: true });
  const rows = dialog.getByTestId('activity-notice');
  await expect(rows).toHaveCount(30);
  await dialog.getByRole('button', { name: '이전 작업 더 보기', exact: true }).click();
  await expect(rows).toHaveCount(42);
  expect(state.historyReads).toEqual(['first', 'synthetic-older-page']);
  await expect(dialog.locator('[data-activity-id="older-failure-11"]')).toBeVisible();
  await dialog.getByRole('button', { name: '모두 확인', exact: true }).scrollIntoViewIfNeeded();
  if (visualReview)
    await page.screenshot({ path: info.outputPath('activity-notifications-mobile.png') });
  await dialog.getByRole('button', { name: '모두 확인', exact: true }).click();
  await expect(rows).toHaveCount(0);
  await state.set([
    ...recent,
    activity('new-failure', 'translation', 'failed'),
    running,
    uncertain,
  ]);
  await expect(dialog.locator('[data-activity-id="new-failure"]')).toBeVisible();
  await expect(
    dialog
      .locator('[data-activity-id="running-job"]')
      .getByRole('button', { name: '확인', exact: true })
  ).toHaveCount(0);
  await expect(
    dialog
      .locator('[data-activity-id="uncertain-job"]')
      .getByRole('button', { name: '확인', exact: true })
  ).toBeEnabled();
  await expect(dialog.locator('[data-activity-id="uncertain-job"]')).toContainText(
    '실행 결과를 확인하지 못했어요.'
  );
  await dialog.getByRole('button', { name: '모두 확인', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId('source')).toHaveCount(1);
  await page.getByRole('button', { name: '작업 상세 보기', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await dialog.getByRole('button', { name: '이전 작업 더 보기', exact: true }).click();
  await expect(rows).toHaveCount(1);
  const retried = { ...recent[0], generation: 2 };
  await state.set([retried, ...recent.slice(1), running, uncertain]);
  await expect(dialog.locator('[data-activity-id="recent-failure-0"]')).toBeVisible();
  await expect(rows).toHaveCount(2);
  expect(state.writes).toHaveLength(2);
  expect(state.writes.every((write) => write.includes('/activity-acknowledgements'))).toBe(true);
  expect((await detail(request, seeded.chat.id)).runs).toEqual(seeded.runs);
});

test('ACTUI17 sidebar copies a nonselected chat and an empty chat immediately while preserving drafts', async ({
  page,
  request,
}, info) => {
  const seeded = await seed(request);
  const response = await request.post('/api/chats', {
    data: { title: '복사할 빈 합성 채팅', botId: seeded.chat.botId },
  });
  expect(response.ok()).toBe(true);
  const empty = (await response.json()) as Chat;
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto(`/?chat=${empty.id}`);
  const composer = page.getByLabel('다음 장면 요청');
  await composer.fill('빈 원본 채팅에 남겨 둘 합성 초안');
  const nav = page.getByTestId('bot-navigation').filter({ visible: true });
  const row = nav.locator(`[data-chat-id="${seeded.chat.id}"]`);
  await row.hover();
  await row.locator('.action-menu > summary').click();
  await expect(row.getByRole('button', { name: '채팅 복사', exact: true })).toBeVisible();
  if (visualReview)
    await page.screenshot({
      path: info.outputPath('sidebar-copy-menu.png'),
      animations: 'disabled',
    });
  const copiedResponse = page.waitForResponse(
    (reply) =>
      reply.url().endsWith(`/api/chats/${seeded.chat.id}/fork`) &&
      reply.request().method() === 'POST'
  );
  await row.getByRole('button', { name: '채팅 복사', exact: true }).click();
  const copiedReply = await copiedResponse;
  expect(copiedReply.ok(), await copiedReply.text()).toBe(true);
  const copy = (await copiedReply.json()) as Chat;
  await expect.poll(() => new URL(page.url()).searchParams.get('chat')).toBe(copy.id);
  const copied = await detail(request, copy.id);
  expect(copied.sources.map((source) => source.text)).toEqual(
    seeded.sources.map((source) => source.text)
  );
  expect((await detail(request, seeded.chat.id)).chat.headRevision).toBe(seeded.chat.headRevision);
  await nav.locator(`[data-chat-id="${empty.id}"] .chat-link`).click();
  await expect(composer).toHaveValue('빈 원본 채팅에 남겨 둘 합성 초안');
  await nav.locator('.bot-navigation-modes > button').nth(1).click();
  const recentRow = nav.locator(`.activity-nav-chat-row[data-chat-id="${empty.id}"]`);
  await recentRow.locator('.action-menu > summary').click();
  const emptyResponse = page.waitForResponse(
    (reply) =>
      reply.url().endsWith(`/api/chats/${empty.id}/fork`) && reply.request().method() === 'POST'
  );
  await recentRow.getByRole('button', { name: '채팅 복사', exact: true }).click();
  const emptyReply = await emptyResponse;
  expect(emptyReply.ok(), await emptyReply.text()).toBe(true);
  const emptyCopy = (await emptyReply.json()) as Chat;
  await expect.poll(() => new URL(page.url()).searchParams.get('chat')).toBe(emptyCopy.id);
  expect((await detail(request, emptyCopy.id)).sources).toHaveLength(0);
  expect((await detail(request, empty.id)).sources).toHaveLength(0);
  await nav
    .locator(`.activity-nav-chat-row[data-chat-id="${empty.id}"] .activity-nav-link`)
    .click();
  await expect(composer).toHaveValue('빈 원본 채팅에 남겨 둘 합성 초안');
});

test('ACTUI19 sidebar activity hides empty sections and acknowledges a row or everything', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  const seeded = await seed(request);
  const second = (await (
    await request.post('/api/chats', {
      data: { title: '두 번째 확인 채팅', botId: seeded.chat.botId },
    })
  ).json()) as Chat;
  const at = new Date().toISOString();
  const item = (chatId: string, key: string, status: 'completed' | 'failed') => ({
    chatId,
    acknowledgementKey: JSON.stringify(['main', key, 0, at]),
    kind: 'main',
    status,
    at,
    actionable: status === 'failed',
    canAcknowledge: true,
  });
  let items = [
    item(seeded.chat.id, 'first-chat', 'completed'),
    item(second.id, 'second-chat', 'failed'),
    item(second.id, 'second-chat-older', 'completed'),
  ];
  const acknowledged: string[][] = [];
  await page.route('**/api/activity-feed', (route) =>
    route.fulfill({ json: { items, running: [] } })
  );
  await page.route('**/api/chats/*/activity-acknowledgements', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const keys = (route.request().postDataJSON() as { keys: string[] }).keys;
    acknowledged.push(keys);
    items = items.filter((entry) => !keys.includes(entry.acknowledgementKey));
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/?chat=${seeded.chat.id}`);
  const nav = page.getByTestId('bot-navigation').filter({ visible: true });
  await nav.getByRole('tab', { name: '활동, 미확인 채팅 2개', exact: true }).click();
  const activity = nav.getByRole('navigation', { name: '채팅 활동' });
  const unread = activity.locator('[data-activity-section="unread"]');
  await expect(unread.locator('.activity-nav-entry')).toHaveCount(2);
  await expect(activity.locator('[data-activity-section="running"]')).toHaveCount(0);
  await unread
    .getByRole('button', {
      name: '두 번째 확인 채팅 활동 2건 확인',
      exact: true,
    })
    .click();
  await expect(unread.locator('.activity-nav-entry')).toHaveCount(1);
  expect(acknowledged).toHaveLength(1);
  expect(acknowledged[0]).toHaveLength(2);
  await unread.getByRole('button', { name: '모두 확인', exact: true }).click();
  await expect(unread).toHaveCount(0);
  expect(acknowledged).toHaveLength(2);
  await expect(activity.locator('[data-activity-section="recent"]')).toBeVisible();
  await expect(
    nav.getByRole('tab', { name: '활동, 미확인 채팅 0개', exact: true })
  ).toHaveAttribute('aria-selected', 'true');
});
