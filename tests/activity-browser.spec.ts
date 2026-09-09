import { visualReview } from './fixtures/visual-review.js';
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
    branchId: null,
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
        data: { ...chat.settings, translation: false, status: false, expectedSettingsRevision: 1 },
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
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method()))
      writes.push(request.method() + ' ' + request.url());
  });
  await page.clock.install({ time: baseTime });
  // Keep the real reader and chat HTTP endpoints; only inject activity projections
  // and deterministic SSE wakeups. No provider request is made by these controls.
  await page.addInitScript(() => {
    class SyntheticStream {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      closed = false;
      constructor() {
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
    body.reader.cursor = cursor;
    body.reader.activeJobs = items.filter((item) =>
      ['queued', 'running', 'waiting_for_state'].includes(item.status)
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
    async set(next: ReaderActivity[]) {
      items = next;
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

test('ACTUI01 elapsed time, collapse, next task and completion expiry', async ({
  page,
  request,
}, info) => {
  const seeded = await seed(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await harness(page, seeded.chat.id, [activity('first')]);
  const status = page.getByTestId('activity-status');
  await expect(status).toContainText('장면을 쓰는 중');
  await expect(status).toContainText(/1[2-9]초/);
  await page.clock.fastForward(2000);
  await expect(status).toContainText(/1[4-9]초/);
  if (visualReview) await page.screenshot({ path: info.outputPath('activity-desktop.png') });
  await page.getByRole('button', { name: '작업 상태 숨기기', exact: true }).click();
  await expect(page.getByRole('button', { name: '작업 상태 펼치기', exact: true })).toBeVisible();
  await state.set([activity('first', 'main', 'completed')]);
  await expect(page.getByRole('button', { name: '작업 상태 숨기기', exact: true })).toHaveCount(0);
  await page.clock.fastForward(4500);
  await expect(status).toHaveCount(0);
  await state.set([activity('second')]);
  await expect(status).toContainText('장면을 쓰는 중');
  await expect(page.getByRole('button', { name: '작업 상태 숨기기', exact: true })).toBeVisible();
  await state.set([activity('second', 'main', 'completed')]);
  await expect(status).toContainText('완료');
  await page.clock.fastForward(4500);
  await expect(status).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('source')).toHaveCount(1);
  await expect(status).toHaveCount(0);
  expect(state.writes).toEqual([]);
  expect((await detail(request, seeded.chat.id)).runs).toEqual(seeded.runs);
});

test('ACTUI04 sending timer starts before admission and continues after accepted request', async ({
  page,
  request,
}) => {
  const seeded = await seed(request);
  const state = await harness(page, seeded.chat.id, []);
  let release!: () => void;
  let admittedId = '';
  const admissionGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/chats/${seeded.chat.id}/runs`, async (route) => {
    await admissionGate;
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    const run = (await response.json()) as Run;
    admittedId = run.id;
    state.project([{ ...activity(run.id), createdAt: iso(0), startedAt: iso(0) }]);
    await route.fulfill({ response });
  });
  await page
    .getByLabel('다음 장면 요청')
    .fill('Synthetic request with deliberately held admission.');
  await page.getByRole('button', { name: '원문 생성', exact: true }).click();
  const status = page.getByTestId('activity-status');
  try {
    await expect(status).toContainText('요청을 보내는 중');
    await page.clock.fastForward(3000);
    await expect(status).toContainText(/[3-9]초/);
    expect((await detail(request, seeded.chat.id)).runs).toHaveLength(seeded.runs.length);
  } finally {
    release();
  }
  await expect(status).toContainText('장면을 쓰는 중');
  await expect(status).toContainText(/[3-9]초/);
  await expect
    .poll(async () => (await detail(request, seeded.chat.id)).runs.length)
    .toBe(seeded.runs.length + 1);
  await state.set([activity(admittedId, 'main', 'completed')]);
  await expect(status).toContainText('완료');
  await page.clock.fastForward(4500);
  await expect(status).toHaveCount(0);
  await state.set([]);
  await expect(status).toHaveCount(0);
  expect(state.writes.filter((write) => write.includes('/runs'))).toHaveLength(1);
});

test('ACTUI02 auxiliary concurrency, mobile bounds and connection uncertainty', async ({
  page,
  request,
}, info) => {
  const seeded = await seed(request);
  const state = await harness(page, seeded.chat.id, [
    activity('translation', 'translation'),
    activity('image', 'image'),
    activity('context', 'context'),
  ]);
  const status = page.getByTestId('activity-status');
  await expect(status).toContainText('번역하는 중');
  await expect(status).toContainText('외 2개');
  await expect(page.getByRole('button', { name: '작업 상세 보기', exact: true })).toBeVisible();
  const bounds = await status.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await status.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (visualReview) await page.screenshot({ path: info.outputPath('activity-mobile.png') });
  await page.getByRole('button', { name: '작업 상태 숨기기', exact: true }).click();
  await page.getByRole('button', { name: '작업 상태 펼치기', exact: true }).click();
  await expect(status).toContainText('번역하는 중');
  await page.evaluate(() => window.dispatchEvent(new Event('test-activity-disconnect')));
  await expect(status).toContainText('연결');
  expect(state.writes).toEqual([]);
});

test('ACTUI03 failure persists, cancellation expires and chat navigation does not replay completion', async ({
  page,
  request,
}) => {
  const seeded = await seed(request),
    other = await seed(request);
  const state = await harness(page, seeded.chat.id, [activity('failed-task')]);
  const status = page.getByTestId('activity-status');
  await expect(status).toContainText('장면을 쓰는 중');
  await state.set([activity('failed-task', 'main', 'failed')]);
  await expect(status).toContainText('실패');
  await page.clock.fastForward(6000);
  await expect(status).toContainText('실패');
  await state.set([activity('cancelled-task')]);
  await expect(status).toContainText('장면을 쓰는 중');
  await state.set([activity('cancelled-task', 'main', 'cancelled')]);
  await expect(status).toContainText('중단');
  await page.clock.fastForward(4500);
  await expect(status).toHaveCount(0);
  await page.evaluate((id) => {
    history.pushState(null, '', `/?chat=${id}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, other.chat.id);
  await expect(page.locator(`[data-source-id="${other.sources[0].id}"]`)).toBeAttached();
  await expect(status).toHaveCount(0);
  await page.evaluate((id) => {
    history.pushState(null, '', `/?chat=${id}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, seeded.chat.id);
  await expect(page.locator(`[data-source-id="${seeded.sources[0].id}"]`)).toBeAttached();
  await expect(status).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test('ACTUI05 old failure does not replace a later completion or cancellation', async ({
  page,
  request,
}) => {
  const seeded = await seed(request);
  const failed = activity('old-failure', 'main', 'failed');
  const next = { ...activity('next-main'), startedAt: iso(-1000), createdAt: iso(-1000) };
  const state = await harness(page, seeded.chat.id, [failed]);
  const status = page.getByTestId('activity-status');
  await expect(status).toContainText('본문 실패');
  await state.set([failed, next]);
  await expect(status).toContainText('장면을 쓰는 중');
  await state.set([failed, { ...next, status: 'completed', finishedAt: iso(0) }]);
  await expect(status).toContainText('본문 완료');
  await expect(status).not.toContainText('실패');
  await page.clock.fastForward(4500);
  await expect(status).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('source')).toHaveCount(1);
  await expect(status).toHaveCount(0);
  const cancelled = { ...next, id: 'cancelled-newest', startedAt: iso(1000) };
  await state.set([failed, cancelled]);
  await expect(status).toContainText('장면을 쓰는 중');
  await state.set([failed, { ...cancelled, status: 'cancelled', finishedAt: iso(2000) }]);
  await expect(status).toContainText('본문 중단됨');
  await page.clock.fastForward(4500);
  await expect(status).toHaveCount(0);
  expect(state.writes).toEqual([]);
  expect((await detail(request, seeded.chat.id)).runs).toEqual(seeded.runs);
});

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
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole('button', { name: '모두 확인', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('activity-notifications-mobile.png') });
  // Bulk acknowledges only the displayed snapshot, even when later SSE events
  // append work to the open dialog. It never mutates persisted job records.
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
  ).toBeDisabled();
  await expect(
    dialog
      .locator('[data-activity-id="uncertain-job"]')
      .getByRole('button', { name: '확인', exact: true })
  ).toBeDisabled();
  await dialog.getByRole('button', { name: '모두 확인', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await page.reload();
  await expect(page.getByTestId('source')).toHaveCount(1);
  await page.getByRole('button', { name: '작업 상세 보기', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await dialog.getByRole('button', { name: '이전 작업 더 보기', exact: true }).click();
  await expect(rows).toHaveCount(2);
  // A retry may retain its job id and timestamp: generation alone must make its
  // new failure visible rather than inheriting the previous acknowledgment.
  const retried = { ...recent[0], generation: 2 };
  await state.set([retried, ...recent.slice(1), running, uncertain]);
  await expect(dialog.locator('[data-activity-id="recent-failure-0"]')).toBeVisible();
  await expect(rows).toHaveCount(3);
  expect(state.writes).toEqual([]);
  expect((await detail(request, seeded.chat.id)).runs).toEqual(seeded.runs);
});

test('ACTUI07 translation success clears only its source hash and failed detail stays confirmable', async ({
  page,
  request,
}, info) => {
  const seeded = await seed(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  const failed: ReaderActivity = {
    ...activity('resolved-translation', 'translation', 'failed'),
    sourceRevision: 'source-a',
    sourceHash: 'hash-a',
  };
  const differentHash = { ...failed, id: 'different-hash', sourceHash: 'hash-b' };
  const differentSource = { ...failed, id: 'different-source', sourceRevision: 'source-b' };
  const imageFailure: ReaderActivity = { ...failed, id: 'image-failure', kind: 'image' };
  const state = await harness(page, seeded.chat.id, [
    failed,
    differentHash,
    differentSource,
    imageFailure,
  ]);
  let detailReads = 0;
  await page.route('**/api/jobs/different-hash', async (route) => {
    detailReads++;
    await route.fulfill({ status: 404, json: { error: 'SYNTHETIC_DETAIL_UNAVAILABLE' } });
  });
  let successfulDetailReads = 0;
  await page.route('**/api/jobs/different-source', async (route) => {
    successfulDetailReads++;
    await route.fulfill({
      json: { status: 'failed', error: 'AUXILIARY_PROVIDER_TIMEOUT', attempt: 1 },
    });
  });
  await page.getByTestId('activity-status').getByRole('button').first().click();
  const dialog = page.getByRole('dialog', { name: '작업 알림', exact: true });
  const rows = dialog.getByTestId('activity-notice');
  await expect(rows).toHaveCount(4);
  expect(detailReads).toBe(0);
  expect(successfulDetailReads).toBe(0);
  await page.screenshot({ path: info.outputPath('activity-notifications-desktop.png') });
  await state.set([
    failed,
    differentHash,
    differentSource,
    imageFailure,
    {
      ...failed,
      id: 'successful-translation',
      status: 'completed',
      startedAt: iso(-1000),
      createdAt: iso(-1000),
      finishedAt: iso(0),
    },
  ]);
  await expect(dialog.locator('[data-activity-id="resolved-translation"]')).toHaveCount(0);
  await expect(rows).toHaveCount(3);
  await expect(dialog.locator('[data-activity-id="different-source"]')).toBeVisible();
  await expect(dialog.locator('[data-activity-id="image-failure"]')).toBeVisible();
  const missing = dialog.locator('[data-activity-id="different-hash"]');
  await missing.getByRole('button', { name: '상세', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('404');
  expect(detailReads).toBe(1);
  await missing.getByRole('button', { name: '확인', exact: true }).click();
  await expect(missing).toHaveCount(0);
  await expect(rows).toHaveCount(2);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const readable = dialog.locator('[data-activity-id="different-source"]');
  await readable.getByRole('button', { name: '상세', exact: true }).click();
  await expect(readable.getByRole('button', { name: '확인됨', exact: true })).toBeDisabled();
  await expect(readable).toContainText('AUXILIARY_PROVIDER_TIMEOUT');
  expect(successfulDetailReads).toBe(1);
  await readable.getByRole('button', { name: '상세', exact: true }).click();
  await expect(readable).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await expect(dialog.locator('[data-activity-id="image-failure"]')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('source')).toHaveCount(1);
  await page.getByRole('button', { name: '작업 상세 보기', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(dialog.locator('[data-activity-id="image-failure"]')).toBeVisible();
  expect(state.writes).toEqual([]);
  expect((await detail(request, seeded.chat.id)).runs).toEqual(seeded.runs);
});

test('ACTUI08 history cannot retain vanished active jobs or revive a previous generation', async ({
  page,
  request,
}) => {
  const seeded = await seed(request);
  const failed = activity('remaining-failure', 'translation', 'failed');
  const running = activity('vanishing-running', 'image');
  const state = await harness(page, seeded.chat.id, [failed, running]);
  const status = page.getByTestId('activity-status');
  const dialog = page.getByRole('dialog', { name: '작업 알림', exact: true });
  const rows = dialog.getByTestId('activity-notice');
  await page.getByRole('button', { name: '작업 상세 보기', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect.poll(() => state.historyReads.length).toBe(1);
  await expect(dialog.getByText('이전 작업을 불러오는 중이에요…', { exact: true })).toHaveCount(0);
  // The reader contains every active job. Removal from its projection must win
  // over an earlier history response, including while the dialog stays open.
  await state.set([failed]);
  await expect(dialog.locator('[data-activity-id="vanishing-running"]')).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await expect(status).not.toContainText('외');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '작업 상세 보기', exact: true }).click();
  await expect.poll(() => state.historyReads.length).toBe(2);
  await expect(rows).toHaveCount(1);
  const interrupted: ReaderActivity = {
    ...activity('retried-vanishing', 'translation', 'interrupted'),
    executionUncertain: true,
  };
  await state.set([failed, interrupted]);
  await expect(rows).toHaveCount(2);
  // Reopen to cache the old interruption, then replace it with a newer execution.
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '작업 상세 보기', exact: true }).click();
  await expect.poll(() => state.historyReads.length).toBe(3);
  await expect(dialog.getByText('이전 작업을 불러오는 중이에요…', { exact: true })).toHaveCount(0);
  const retry = {
    ...interrupted,
    generation: 2,
    status: 'running',
    executionUncertain: false,
    finishedAt: null,
  };
  await state.set([failed, retry]);
  const retryRow = dialog.locator('[data-activity-id="retried-vanishing"]');
  await expect(retryRow).toContainText('번역하는 중');
  await expect(rows).toHaveCount(2);
  await state.set([failed]);
  await expect(retryRow).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await expect(status).not.toContainText('외');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '작업 상세 보기', exact: true }).click();
  await expect.poll(() => state.historyReads.length).toBe(4);
  await expect(rows).toHaveCount(1);
  await expect(retryRow).toHaveCount(0);
  expect(state.writes).toEqual([]);
  expect((await detail(request, seeded.chat.id)).runs).toEqual(seeded.runs);
});
