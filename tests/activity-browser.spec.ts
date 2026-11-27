import { postFixtureChat } from './fixtures/chat.js';
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
