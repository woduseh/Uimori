import { MOBILE_WIDTH, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
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

test('AUDIT2 pending notification history does not claim empty after acknowledging the visible notice', async ({
  page,
  request,
}, info) => {
  const seeded = await seed(request);
  await page.setViewportSize({ width: 360, height: 900 });
  const state = await harness(page, seeded.chat.id, [
    activity('pending-history', 'translation', 'failed'),
  ]);
  let requested = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/chats/${seeded.chat.id}/activities?*`, async (route) => {
    requested = true;
    await held;
    await route.fulfill({ json: { items: [], nextCursor: null } });
  });
  try {
    await page.getByRole('button', { name: '작업 상세 보기', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '작업 알림', exact: true });
    await expect.poll(() => requested).toBe(true);
    await dialog.getByRole('button', { name: '모두 확인', exact: true }).click();
    await page.clock.runFor(250);
    await expect(dialog.getByText('이전 작업을 불러오는 중이에요…', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('notification-history-pending-360.png') });
    await expect(dialog.getByText('확인할 알림이 없어요.', { exact: true })).toHaveCount(0);
    release();
    await expect(dialog.getByText('확인할 알림이 없어요.', { exact: true })).toBeVisible();
    expect(state.writes).toHaveLength(1);
    expect(state.writes.every((write) => write.includes('/activity-acknowledgements'))).toBe(true);
  } finally {
    release();
  }
});

test('ACTUI01 elapsed time, collapse, next task and completion expiry', async ({
  page,
  request,
}, info) => {
  const seeded = await seed(request);
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
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
  await state.set([], [admittedId]);
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
    activity('status', 'status'),
  ]);
  const status = page.getByTestId('activity-status');
  await expect(status).toContainText('번역하는 중');
  await expect(status).toContainText('외 1개');
  await expect(status).not.toContainText('이전 보조 작업');
  await expect(page.getByRole('button', { name: '작업 상세 보기', exact: true })).toBeVisible();
  const bounds = await status.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(MOBILE_WIDTH);
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
  await expect(status).toContainText('본문 취소됨');
  await expect(status.locator('svg.lucide-square')).toHaveCount(1);
  await expect(status.locator('svg.lucide-check')).toHaveCount(0);
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
  await expect(status).toContainText('본문 취소됨');
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
  const metadata = rows.first().locator('.activity-notification-heading .ui-meta-row');
  expect(
    await metadata.evaluate((element) => {
      const [date, identity] = Array.from(element.children).map((child) =>
        child.getBoundingClientRect()
      );
      return identity.top >= date.bottom || identity.left >= date.right + 4;
    })
  ).toBe(true);
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
  ).toBeEnabled();
  await expect(dialog.locator('[data-activity-id="uncertain-job"]')).toContainText(
    '실행 결과가 불확실해요'
  );
  await dialog.getByRole('button', { name: '모두 확인', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId('source')).toHaveCount(1);
  await page.getByRole('button', { name: '작업 상세 보기', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await dialog.getByRole('button', { name: '이전 작업 더 보기', exact: true }).click();
  await expect(rows).toHaveCount(1);
  // A retry may retain its job id and timestamp: generation alone must make its
  // new failure visible rather than inheriting the previous acknowledgment.
  const retried = { ...recent[0], generation: 2 };
  await state.set([retried, ...recent.slice(1), running, uncertain]);
  await expect(dialog.locator('[data-activity-id="recent-failure-0"]')).toBeVisible();
  await expect(rows).toHaveCount(2);
  expect(state.writes).toHaveLength(2);
  expect(state.writes.every((write) => write.includes('/activity-acknowledgements'))).toBe(true);
  expect((await detail(request, seeded.chat.id)).runs).toEqual(seeded.runs);
});

test('ACTUI07 translation success clears only its source hash and failed detail stays confirmable', async ({
  page,
  request,
}, info) => {
  const seeded = await seed(request);
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
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
  expect(state.writes).toHaveLength(3);
  expect(state.writes.every((write) => write.includes('/activity-acknowledgements'))).toBe(true);
  expect((await detail(request, seeded.chat.id)).runs).toEqual(seeded.runs);
});

test('ACTUI12 illustration notification detail reads its illustration and preserves execution identity', async ({
  page,
  request,
}) => {
  const seeded = await seed(request);
  const illustration = activity('illustration-notice', 'illustration', 'failed');
  const state = await harness(page, seeded.chat.id, [illustration]);
  const reads: string[] = [];
  page.on('request', (outbound) => {
    const path = new URL(outbound.url()).pathname;
    if (path.endsWith('/illustration-notice')) reads.push(path);
  });
  await page.route('**/api/illustrations/illustration-notice', (route) =>
    route.fulfill({ json: { status: 'failed', attempt: 1, generation: 2 } })
  );
  await page.getByRole('button', { name: '작업 상세 보기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '작업 알림', exact: true });
  const row = dialog.locator('[data-activity-id="illustration-notice"]');
  await row.getByRole('button', { name: '상세', exact: true }).click();
  await expect(row).toContainText('새 실행으로 바뀌어');
  await expect(row.getByRole('button', { name: '확인', exact: true })).toBeEnabled();
  expect(state.writes).toEqual([]);
  await row.getByRole('button', { name: '상세', exact: true }).click();
  await page.route('**/api/illustrations/illustration-notice', (route) =>
    route.fulfill({ json: { status: 'failed', attempt: 0, generation: 1 } })
  );
  await row.getByRole('button', { name: '상세', exact: true }).click();
  await expect(row).toContainText('상태: 실패');
  await expect(row.getByRole('button', { name: '확인됨', exact: true })).toBeDisabled();
  expect(reads).toEqual([
    '/api/illustrations/illustration-notice',
    '/api/illustrations/illustration-notice',
  ]);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toContain('/activity-acknowledgements');
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

test('ACTUI09 confirmations survive a fresh browser session while new executions remain visible', async ({
  page,
  request,
  browser,
}) => {
  const seeded = await seed(request);
  const failed = activity('reopened-failure', 'translation', 'failed');
  await harness(page, seeded.chat.id, [failed]);
  await page.getByRole('button', { name: '작업 상세 보기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '작업 알림', exact: true });
  await dialog.getByRole('button', { name: '모두 확인', exact: true }).click();
  await expect(dialog.getByTestId('activity-notice')).toHaveCount(0);
  // A fresh context restores cookies/localStorage but no tab sessionStorage.
  const storageState = await page.context().storageState();
  await page.close();
  const context = await browser.newContext({ storageState });
  try {
    const reopened = await context.newPage();
    const state = await harness(reopened, seeded.chat.id, [failed]);
    await expect(reopened.getByTestId('activity-status')).toHaveCount(0);
    await state.set([{ ...failed, generation: 2 }]);
    await expect(reopened.getByTestId('activity-status')).toContainText('실패');
    await reopened.getByRole('button', { name: '작업 상세 보기', exact: true }).click();
    await expect(reopened.getByTestId('activity-notice')).toHaveCount(1);
    expect(state.writes).toEqual([]);
    expect((await detail(request, seeded.chat.id)).runs).toEqual(seeded.runs);
  } finally {
    await context.close();
  }
});

test('ACTUI10 activity icon mode groups unread results and keeps recent chats across desktop and mobile', async ({
  page,
  request,
}) => {
  const seeded = await seed(request);
  let confirmed = false;
  const at = new Date().toISOString();
  await page.route('**/api/activity-feed', (route) =>
    route.fulfill({
      json: {
        items: confirmed
          ? []
          : [
              {
                chatId: seeded.chat.id,
                acknowledgementKey: JSON.stringify(['main', 'synthetic-inbox', 0, at]),
                kind: 'main',
                status: 'completed',
                label: '본문 완료',
                at,
                sourceId: null,
                representation: 'original',
                actionable: false,
                canAcknowledge: true,
              },
            ],
        running: [],
      },
    })
  );
  await page.route(`**/api/chats/${seeded.chat.id}/activity-acknowledgements`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    confirmed = true;
    await route.fulfill({ json: { ok: true } });
  });
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto(`/?chat=${seeded.chat.id}`);
  const nav = page.getByTestId('bot-navigation').filter({ visible: true });
  const activityMode = nav.locator('.bot-navigation-modes > button').nth(1);
  await expect(activityMode).toBeVisible();
  await activityMode.click();
  await expect(activityMode).toHaveAttribute('aria-pressed', 'true');
  const activityNav = nav.getByRole('navigation', { name: '채팅 활동' });
  await expect(activityNav.getByText('확인할 활동', { exact: true })).toBeVisible();
  await expect(activityNav.getByText(seeded.chat.title, { exact: true }).first()).toBeVisible();
  await activityNav
    .getByRole('button', { name: new RegExp(`${seeded.chat.title} 활동 .* 확인`) })
    .click();
  await expect(activityNav.getByText('확인할 활동이 없어요.')).toBeVisible();
  await expect(activityNav.getByText(seeded.chat.title, { exact: true }).first()).toBeVisible();
  await nav.locator('.bot-navigation-modes > button').first().click();
  await expect(nav.locator('.bot-tree-section-heading')).toBeVisible();
  await activityMode.click();
  await expect(activityMode).toHaveAttribute('aria-pressed', 'true');
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 900 });
  await page.getByRole('button', { name: '탐색 메뉴', exact: true }).click();
  const mobile = page.getByRole('dialog', { name: '탐색' }).getByTestId('bot-navigation');
  await expect(mobile.locator('.bot-navigation-modes > button').nth(1)).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(
    mobile
      .getByRole('navigation', { name: '채팅 활동' })
      .getByText(seeded.chat.title, { exact: true })
  ).toBeVisible();
});

test('ACTUI13 recent helper jobs open their sessions without replacing the reader', async ({
  page,
  request,
}) => {
  const seeded = await seed(request);
  const create = async (
    scope: { kind: 'chat'; chatId: string } | { kind: 'library'; workId: string }
  ) => {
    const response = await request.post('/api/helper/conversations/new', {
      data: { scope, requestKey: `activity-helper-${Math.random().toString(36).slice(2)}` },
    });
    expect(response.ok()).toBeTruthy();
    return (await response.json()) as { id: string };
  };
  const chat = await create({ kind: 'chat', chatId: seeded.chat.id });
  const library = await create({ kind: 'library', workId: 'library:bot' });
  const now = new Date().toISOString();
  await page.route('**/api/activity-feed', (route) =>
    route.fulfill({
      json: {
        items: [],
        running: [],
        helpers: [
          {
            id: 'synthetic-chat-job',
            conversationId: chat.id,
            chatId: seeded.chat.id,
            workId: null,
            title: '합성 작품 도우미',
            modelTitle: 'Synthetic',
            status: 'completed',
            updatedAt: now,
            committedEffects: 0,
          },
          {
            id: 'synthetic-library-job',
            conversationId: library.id,
            chatId: null,
            workId: 'library:bot',
            title: '합성 서재 도우미',
            modelTitle: 'Synthetic',
            status: 'failed',
            updatedAt: now,
            committedEffects: 1,
          },
        ],
      },
    })
  );
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto(`/?chat=${seeded.chat.id}`);
  const nav = page.getByTestId('bot-navigation').filter({ visible: true });
  await nav.locator('.bot-navigation-modes > button').nth(1).click();
  const activityNav = nav.getByRole('navigation', { name: '채팅 활동' });
  await activityNav.locator('[data-activity-section="helpers"] .activity-nav-heading').click();
  await activityNav.getByRole('button', { name: /합성 작품 도우미/ }).click();
  const panel = page.locator('.helper-panel').filter({ visible: true });
  await expect(
    panel.getByRole('combobox', { name: '도우미 세션 선택', includeHidden: true })
  ).toHaveValue(chat.id);
  await expect(page.getByRole('dialog', { name: '도우미 작업 기록' })).toBeVisible();
  await page.getByRole('button', { name: '도우미 작업 기록 닫기', exact: true }).click();
  await panel.getByRole('button', { name: seeded.chat.title, exact: true }).click();
  await activityNav.getByRole('button', { name: /합성 서재 도우미/ }).click();
  await expect(
    panel.getByRole('combobox', { name: '도우미 세션 선택', includeHidden: true })
  ).toHaveValue(library.id);
  await page.getByRole('button', { name: '도우미 작업 기록 닫기', exact: true }).click();
  await panel.getByRole('button', { name: seeded.chat.title, exact: true }).click();
  await expect(page.getByRole('heading', { name: seeded.chat.title, exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`chat=${seeded.chat.id}`));
  await expect(activityNav.getByText('확정된 앱 작업 1건')).toBeVisible();
});

test('ACTUI14 activity sections show 5 then more, retain folding and never exclude recent chats', async ({
  page,
  request,
}) => {
  const seeded = await seed(request);
  for (let i = 0; i < 8; i++) {
    const response = await request.post('/api/chats', {
      data: { title: `추가 탐색 ${i}`, botId: seeded.chat.botId },
    });
    expect(response.ok()).toBe(true);
  }
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto(`/?chat=${seeded.chat.id}`);
  const nav = page.getByTestId('bot-navigation').filter({ visible: true });
  await nav.locator('.bot-navigation-modes > button').nth(1).click();
  const activity = nav.getByRole('navigation', { name: '채팅 활동' });
  const recent = activity.locator('[data-activity-section="recent"]');
  const total = Number(
    await recent.locator('.activity-nav-heading > span:last-child').textContent()
  );
  expect(total).toBeGreaterThanOrEqual(9);
  await expect(recent.locator('.activity-nav-link')).toHaveCount(5);
  await expect(recent.locator('.activity-nav-more')).toContainText(
    `${Math.min(20, total - 5)}개 더 보기`
  );
  await recent.locator('.activity-nav-more').click();
  await expect(recent.locator('.activity-nav-link')).toHaveCount(Math.min(total, 25));
  await recent.locator('.activity-nav-heading').click();
  await expect(recent.locator('.activity-nav-link')).toHaveCount(0);
  await recent.locator('.activity-nav-heading').click();
  await expect(recent.locator('.activity-nav-link')).toHaveCount(Math.min(total, 25));
  await page.reload();
  const restored = page.getByTestId('bot-navigation').filter({ visible: true });
  const restoredRecent = restored.locator('[data-activity-section="recent"]');
  await expect(restoredRecent.locator('.activity-nav-link')).toHaveCount(5);
  await expect(restoredRecent.locator('.activity-nav-heading')).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await restored.locator('.bot-navigation-modes > button').first().click();
  const branch = restored.locator(`[data-bot-id="${seeded.chat.botId}"]`);
  await expect(branch.locator('.bot-chat-item')).toHaveCount(6);
  const pinned = branch.locator('.bot-chat-item').first();
  await expect(pinned).toHaveClass(/pinned/);
  await expect(pinned).toHaveAttribute('draggable', 'false');
  await expect(pinned.getByText('현재 채팅')).toBeVisible();
  const firstVisible = branch.locator('.bot-chat-item:not(.pinned)').first();
  const movedId = await firstVisible.getAttribute('data-chat-id');
  const chatOrder = async () => {
    const response = await request.get('/api/chats');
    const all = (await response.json()) as Chat[];
    return all
      .filter((chat) => chat.botId === seeded.chat.botId && !chat.folderId)
      .sort((a, b) => (a.sortPosition ?? 0) - (b.sortPosition ?? 0))
      .map((chat) => chat.id);
  };
  await firstVisible.dragTo(branch.locator('.bot-chat-more'));
  await expect.poll(async () => (await chatOrder()).indexOf(movedId!)).toBe(4);
  await branch.locator('.bot-chat-more').click();
  await expect(branch.locator('.bot-chat-item')).toHaveCount(9);
  // Compact navigation must retain the pinned shortcut without horizontal overflow.
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 900 });
  await page.getByRole('button', { name: '탐색 메뉴', exact: true }).click();
  const mobileBranch = page
    .getByRole('dialog', { name: '탐색' })
    .locator(`[data-bot-id="${seeded.chat.botId}"]`);
  await expect(mobileBranch.locator('.bot-chat-item.pinned')).toHaveCount(1);
  expect(
    await mobileBranch.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
  ).toBe(true);
});

test('ACTUI16 recent navigation groups saved dates and keeps active helpers ahead of dated history', async ({
  page,
  request,
}, info) => {
  const seeded = await seed(request);
  const chats = [seeded.chat];
  for (const title of ['어제의 합성 채팅', '지난주의 합성 채팅']) {
    const response = await request.post('/api/chats', {
      data: { title, botId: seeded.chat.botId },
    });
    expect(response.ok()).toBe(true);
    chats.push((await response.json()) as Chat);
  }
  // The selected chat also refreshes from the real reader endpoint with today's activity date.
  const now = new Date();
  const previousDay = new Date(now);
  previousDay.setDate(previousDay.getDate() - 1);
  previousDay.setHours(23, 59, 0, 0);
  const yesterday = previousDay.toISOString();
  const previousWeek = new Date(now);
  previousWeek.setDate(previousWeek.getDate() - 5);
  const earlier = previousWeek.toISOString();
  await page.clock.install({ time: now });
  await page.route('**/api/chats', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: chats.map((chat, index) => ({
            ...chat,
            lastActivityAt: [now.toISOString(), yesterday, earlier][index],
          })),
        })
      : route.continue()
  );
  await page.route('**/api/activity-feed', (route) =>
    route.fulfill({
      json: {
        items: [],
        running: [],
        helpers: [
          {
            id: 'active-old',
            conversationId: 'synthetic',
            chatId: seeded.chat.id,
            workId: null,
            title: '지난주부터 진행 중인 합성 작업',
            status: 'running',
            updatedAt: earlier,
            committedEffects: 0,
          },
          {
            id: 'completed-today',
            conversationId: 'synthetic',
            chatId: seeded.chat.id,
            workId: null,
            title: '오늘 완료한 합성 작업',
            status: 'completed',
            updatedAt: now.toISOString(),
            committedEffects: 0,
          },
          {
            id: 'completed-yesterday',
            conversationId: 'synthetic',
            chatId: seeded.chat.id,
            workId: null,
            title: '어제 완료한 합성 작업',
            status: 'completed',
            updatedAt: yesterday,
            committedEffects: 0,
          },
        ],
      },
    })
  );
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  await page.goto(`/?chat=${seeded.chat.id}`);
  const nav = page.getByTestId('bot-navigation').filter({ visible: true });
  await nav.locator('.bot-navigation-modes > button').nth(1).click();
  const recent = nav.locator('[data-activity-section="recent"]');
  await expect(recent.locator('.activity-nav-date-group > h3')).toHaveText([
    '오늘',
    '어제',
    '지난 7일',
  ]);
  await expect(recent.locator('.activity-nav-date-group').nth(1)).toContainText(chats[1].title);
  const helpers = nav.locator('[data-activity-section="helpers"]');
  await helpers.locator('.activity-nav-heading').click();
  await expect(helpers.locator('.activity-nav-date-group > h3')).toHaveText([
    '진행 중',
    '오늘',
    '어제',
  ]);
  await expect(helpers.locator('.activity-nav-link').first()).toContainText(
    '지난주부터 진행 중인 합성 작업'
  );
  await expect(helpers.locator('time').first()).toHaveAttribute('datetime', earlier);
  await page.screenshot({
    path: info.outputPath('recent-date-groups-desktop.png'),
    animations: 'disabled',
  });
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 900 });
  await page.getByRole('button', { name: '탐색 메뉴', exact: true }).click();
  const mobileRecent = page
    .getByRole('dialog', { name: '탐색' })
    .locator('[data-activity-section="recent"]');
  await expect(mobileRecent.locator('.activity-nav-date-group > h3')).toHaveText([
    '오늘',
    '어제',
    '지난 7일',
  ]);
  await mobileRecent.locator('.activity-nav-chat-row .action-menu > summary').first().click();
  await expect(
    mobileRecent.getByRole('button', { name: '채팅 복사', exact: true }).first()
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath('recent-copy-mobile.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '탐색' })).toBeVisible();
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
  await expect(row.locator('.bot-row-actions')).toHaveCSS('opacity', '1');
  await row.locator('.action-menu > summary').click();
  await expect(row.getByRole('button', { name: '채팅 복사', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('sidebar-copy-menu.png'), animations: 'disabled' });
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

for (const width of [DESKTOP_WIDTH, MOBILE_WIDTH]) {
  test(`ACTUI18 ${width}px recent chat menus rename and delete without changing the current draft`, async ({
    page,
    request,
  }, info) => {
    const seeded = await seed(request);
    const created = await request.post('/api/chats', {
      data: { title: `최근 목록에서 관리할 채팅 ${width}`, botId: seeded.chat.botId },
    });
    expect(created.ok()).toBe(true);
    const target = (await created.json()) as Chat;
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?chat=${seeded.chat.id}`);
    const composer = page.getByLabel('다음 장면 요청');
    const draft = `현재 채팅에 남겨 둘 합성 초안 ${width}`;
    await composer.fill(draft);
    if (width === MOBILE_WIDTH)
      await page.getByRole('button', { name: '탐색 메뉴', exact: true }).click();
    const nav = page.getByTestId('bot-navigation').filter({ visible: true });
    await nav.locator('.bot-navigation-modes > button').nth(1).click();
    const row = nav.locator(`.activity-nav-chat-row[data-chat-id="${target.id}"]`);
    const trigger = row.locator('.action-menu > summary');
    const actions = row.locator('.action-menu-body');
    await trigger.click();
    await expect(actions.getByRole('button')).toHaveText(['채팅 복사', '제목 변경', '채팅 삭제']);
    await page.screenshot({
      path: info.outputPath(`recent-chat-menu-${width}.png`),
      animations: 'disabled',
    });
    await actions.getByRole('button', { name: '제목 변경', exact: true }).click();
    const rename = page.getByRole('dialog', { name: '채팅 제목 변경', exact: true });
    const title = rename.getByRole('textbox', { name: '채팅 제목', exact: true });
    await title.fill('취소할 제목 초안');
    await rename.getByRole('button', { name: '취소', exact: true }).click();
    await expect(rename).toBeHidden();
    await expect(trigger).toBeFocused();
    expect((await detail(request, target.id)).chat.title).toBe(target.title);
    await trigger.click();
    await actions.getByRole('button', { name: '제목 변경', exact: true }).click();
    await expect(title).toHaveValue(target.title);
    const renamed = `최근 목록에서 바꾼 제목 ${width}`;
    await title.fill(renamed);
    await rename.getByRole('button', { name: '제목 저장', exact: true }).click();
    await expect(rename).toBeHidden();
    await expect(trigger).toHaveAccessibleName(`${renamed} 채팅 메뉴`);
    expect((await detail(request, target.id)).chat.title).toBe(renamed);
    expect(new URL(page.url()).searchParams.get('chat')).toBe(seeded.chat.id);
    await expect(composer).toHaveValue(draft);
    await trigger.click();
    await actions.getByRole('button', { name: `${renamed} 채팅 삭제`, exact: true }).click();
    const deletion = page.getByRole('alertdialog', { name: '삭제 확인', exact: true });
    await expect(deletion).toContainText(renamed);
    await deletion.getByRole('button', { name: '취소', exact: true }).click();
    await expect(deletion).toBeHidden();
    await expect(trigger).toBeFocused();
    expect((await request.get(`/api/chats/${target.id}`)).ok()).toBe(true);
    await trigger.click();
    await actions.getByRole('button', { name: `${renamed} 채팅 삭제`, exact: true }).click();
    await deletion.getByRole('button', { name: '영구 삭제', exact: true }).click();
    await expect(row).toHaveCount(0);
    expect((await request.get(`/api/chats/${target.id}`)).status()).toBe(404);
    expect(new URL(page.url()).searchParams.get('chat')).toBe(seeded.chat.id);
    await expect(composer).toHaveValue(draft);
    expect((await detail(request, seeded.chat.id)).sources.map((source) => source.text)).toEqual(
      seeded.sources.map((source) => source.text)
    );
    if (width === MOBILE_WIDTH)
      await expect(page.getByRole('dialog', { name: '탐색', exact: true })).toBeVisible();
  });
}

test('ACTUI11 an already visible source is confirmed only after its inbox entry is selected', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  const seeded = await seed(request);
  const sourceId = seeded.sources[0].id;
  const at = new Date().toISOString();
  let confirmed = false;
  let confirmations = 0;
  const legacyReads: string[] = [];
  page.on('request', (outbound) => {
    if (new URL(outbound.url()).pathname === '/api/chat-activities')
      legacyReads.push(outbound.url());
  });
  await page.route('**/api/activity-feed', (route) =>
    route.fulfill({
      json: {
        items: confirmed
          ? []
          : [
              {
                chatId: seeded.chat.id,
                acknowledgementKey: JSON.stringify(['main', 'synthetic-source-inbox', 0, at]),
                kind: 'main',
                status: 'completed',
                label: '본문 완료',
                at,
                sourceId,
                representation: 'original',
                actionable: false,
                canAcknowledge: true,
              },
            ],
        running: [],
      },
    })
  );
  await page.route(`**/api/chats/${seeded.chat.id}/activity-acknowledgements`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    confirmed = true;
    confirmations++;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/?chat=${seeded.chat.id}`);
  await expect(page.locator(`[data-source-id="${sourceId}"]`)).toBeInViewport();
  const nav = page.getByTestId('bot-navigation').filter({ visible: true });
  await nav.locator('.bot-navigation-modes > button').nth(1).click();
  const activity = nav.getByRole('navigation', { name: '채팅 활동' });
  await expect(activity.locator('.activity-nav-entry')).toHaveCount(1);
  expect(confirmations).toBe(0);
  expect(legacyReads).toEqual([]);
  await activity.locator('.activity-nav-entry .activity-nav-link').click();
  await expect.poll(() => confirmations).toBe(1);
  await expect(activity.getByText('확인할 활동이 없어요.')).toBeVisible();
});
