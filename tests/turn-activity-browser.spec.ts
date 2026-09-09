import { visualReview } from './fixtures/visual-review.js';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Chat, ChatDetail, Job, ReaderActivity, ReaderDetail, Run } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';

test.setTimeout(60000);

async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${id}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function seed(request: APIRequestContext, count = 1) {
  const response = await postFixtureChat(request, {
    data: { title: `Turn activity synthetic ${Date.now()}` },
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
  for (let index = 0; index < count; index++) {
    const before = await detail(request, chat.id);
    const created = await request.post(`/api/chats/${chat.id}/runs`, {
      data: {
        request: `Synthetic scene ${index + 1}: a lantern lights the quiet river.`,
        expectedRevision: before.chat.headRevision,
        expectedSettingsRevision: before.chat.settingsRevision,
        idempotencyKey: `turn-activity-${chat.id}-${index}`,
      },
    });
    expect(created.ok()).toBeTruthy();
    const run = (await created.json()) as Run;
    await expect
      .poll(
        async () => (await detail(request, chat.id)).runs.find((item) => item.id === run.id)?.status
      )
      .toBe('completed');
  }
  return detail(request, chat.id);
}

function activity(
  sourceRevision: string,
  kind: ReaderActivity['kind'],
  status: string
): ReaderActivity {
  const now = new Date().toISOString();
  return {
    id: `synthetic-${kind}-${sourceRevision}`,
    kind,
    status,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: status === 'running' ? null : now,
    branchId: null,
    sourceRevision,
    generation: 1,
  };
}

async function harness(
  page: Page,
  chatId: string,
  initial: (body: ReaderDetail) => void = () => {}
) {
  let project = initial;
  let cursor = 1000000;
  const writes: string[] = [];
  const runReads: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method()))
      writes.push(`${request.method()} ${request.url()}`);
    if (/\/api\/runs\/[^/?]+$/.test(request.url()) && request.method() === 'GET')
      runReads.push(request.url());
  });
  // Real HTTP-seeded runs and reader payloads; control only the projected state
  // and SSE wakeups to exercise failure/progress without a live provider call.
  await page.addInitScript(() => {
    class SyntheticStream {
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      closed = false;
      constructor() {
        setTimeout(() => this.onopen?.(), 0);
        window.addEventListener('test-turn-refresh', (event) => {
          if (!this.closed)
            this.onmessage?.({
              data: JSON.stringify({ kind: 'story.job', seq: (event as CustomEvent).detail }),
            });
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
    project(body);
    body.reader.cursor = cursor;
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/?chat=${chatId}`);
  await expect(page.getByTestId('turn-activity').first()).toBeVisible();
  return {
    writes,
    runReads,
    async set(next: (body: ReaderDetail) => void) {
      project = next;
      cursor++;
      const response = page.waitForResponse(
        (item) => item.url().includes(`/chats/${chatId}/reader?`) && item.ok()
      );
      await page.evaluate(
        (seq) => window.dispatchEvent(new CustomEvent('test-turn-refresh', { detail: seq })),
        cursor
      );
      await response;
    },
  };
}

test('TURNUI01 independent response panels, lazy inspector and reload persistence', async ({
  page,
  request,
}, info) => {
  const seeded = await seed(request, 2);
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await harness(page, seeded.chat.id);
  const panels = page.getByTestId('source').getByTestId('turn-activity');
  await expect(panels).toHaveCount(2);
  const first = panels.nth(0);
  const second = panels.nth(1);
  await expect(first).not.toHaveAttribute('open');
  await expect(second).not.toHaveAttribute('open');
  await expect(first.locator(':scope > summary')).toContainText('본문 완료');
  await expect(page.getByRole('button', { name: '실행 상세', exact: true })).toHaveCount(0);
  await first.locator(':scope > summary').click();
  await expect(first).toHaveAttribute('open', '');
  await expect(second).not.toHaveAttribute('open');
  expect(state.runReads).toEqual([]);
  await second.locator(':scope > summary').click();
  await expect(first).toHaveAttribute('open', '');
  await expect(second).toHaveAttribute('open', '');
  await first.getByText('실행과 실제 입력 확인', { exact: true }).click();
  await expect(first.locator('pre').last()).toContainText('snapshot');
  expect(state.runReads).toHaveLength(1);
  await first.getByText('실행과 실제 입력 확인', { exact: true }).click();
  await expect(first.getByRole('textbox')).toHaveCount(0);
  await first.locator(':scope > summary').click();
  await page.reload();
  await expect(first).not.toHaveAttribute('open');
  await expect(second).toHaveAttribute('open', '');
  await second.scrollIntoViewIfNeeded();
  if (visualReview) await page.screenshot({ path: info.outputPath('turn-activity-desktop.png') });
  expect(state.writes).toEqual([]);
  expect((await detail(request, seeded.chat.id)).runs).toEqual(seeded.runs);
});

test('TURNUI02 folded auxiliary progress updates preserve explicit expansion and ownership', async ({
  page,
  request,
}) => {
  const seeded = await seed(request, 2);
  const source = seeded.sources[0]!;
  const project = (status: Job['status']) => (body: ReaderDetail) => {
    body.jobs = [
      {
        id: `synthetic-translation-${source.id}`,
        chatId: seeded.chat.id,
        sourceRevision: source.id,
        sourceHash: source.hash,
        kind: 'translation',
        status,
        attempt: 1,
        error: status === 'failed' ? 'SYNTHETIC_TRANSLATION_FAILURE' : null,
        result: null,
        revision: 1,
      },
    ];
    for (const mode of ['original', 'translation'] as const) {
      body.jobs.push({
        ...body.jobs[0],
        id: `synthetic-image-${mode}-${source.id}`,
        kind: 'image',
        revision: mode === 'original' ? 1 : 2,
        imageTarget:
          mode === 'original'
            ? { mode, textHash: source.hash }
            : {
                mode,
                textHash: source.hash,
                translationJobId: body.jobs[0].id,
                translationRevision: 1,
              },
      });
    }
    body.reader.responseActivity = [
      activity(source.id, 'translation', status),
      activity(source.id, 'state', status),
      activity(source.id, 'context', status),
    ];
    if (status === 'completed')
      body.reader.responseActivity.unshift({
        ...activity(source.id, 'state', 'stale'),
        id: `synthetic-previous-state-${source.id}`,
        createdAt: '2020-01-01T00:00:00.000Z',
        startedAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:01.000Z',
        finishedAt: '2020-01-01T00:00:01.000Z',
      });
  };
  const state = await harness(page, seeded.chat.id, project('running'));
  const panel = page.locator(`[data-testid="turn-activity"][data-run-id="${source.runId}"]`);
  const otherSource = seeded.sources.find((item) => item.id !== source.id)!;
  const other = page.locator(`[data-testid="turn-activity"][data-run-id="${otherSource.runId}"]`);
  await expect(panel.locator(':scope > summary')).toContainText(/번역.*중/);
  await expect(panel.locator(':scope > summary')).toContainText('상태 정리 진행 중');
  await expect(panel.locator(':scope > summary')).toContainText('문맥 압축 진행 중');
  await expect(panel.locator(':scope > summary')).toContainText('원문 이미지 배치 진행 중');
  await expect(panel.locator(':scope > summary')).toContainText('번역 이미지 배치 진행 중');
  await expect(panel).not.toHaveAttribute('open');
  await state.set(project('failed'));
  await expect(panel.locator(':scope > summary')).toContainText('번역 실패');
  await expect(panel.locator(':scope > summary')).toContainText('본문 완료');
  await expect(other.locator(':scope > summary')).not.toContainText('번역');
  await expect(other.locator(':scope > summary')).not.toContainText('정리');
  await expect(panel).not.toHaveAttribute('open');
  await panel.locator(':scope > summary').click();
  await expect(panel.getByText('상태 정리 · 실패 · 작업 관리', { exact: true })).toBeVisible();
  await expect(panel.getByRole('region', { name: '이 응답의 문맥 작업' })).toContainText(
    '문맥 압축 · 실패'
  );
  await state.set(project('completed'));
  await expect(panel.locator(':scope > summary')).not.toContainText('실패');
  await expect(panel.locator(':scope > summary')).not.toContainText('이전 자료의 결과');
  await expect(panel).not.toHaveClass(/turn-activity-issue/);
  const previous = panel.getByText('이전 상태 작업 · 1개', { exact: true });
  await expect(previous).toBeVisible();
  await previous.click();
  await expect(panel.getByText('상태 정리 · 이전 자료의 결과', { exact: true })).toBeVisible();
  await expect(panel).toHaveAttribute('open', '');
  await expect(other.locator(':scope > summary').filter({ hasText: '번역 실패' })).toHaveCount(0);
  expect(state.writes).toEqual([]);
  expect((await detail(request, seeded.chat.id)).runs).toEqual(seeded.runs);
});

test('TURNUI04 expanded pending run preserves disclosure when its source arrives', async ({
  page,
  request,
}) => {
  const seeded = await seed(request);
  const run = seeded.runs[0]!;
  const state = await harness(page, seeded.chat.id, (body) => {
    body.sources = [];
    body.jobs = [];
    body.runs = body.runs.map((item) =>
      item.id === run.id ? { ...item, sourceRevision: null, status: 'running', error: null } : item
    );
    body.reader.responseActivity = [];
    body.reader.activity = [];
    body.reader.order = [];
    body.reader.navigation = [];
    body.reader.total = 0;
    body.reader.latest = null;
    body.reader.activeJobs = 1;
  });
  const pending = page.getByTestId('pending-run').getByTestId('turn-activity');
  await expect(pending.locator(':scope > summary')).toContainText('장면을 쓰는 중');
  await pending.locator(':scope > summary').click();
  await expect(pending).toHaveAttribute('open', '');
  await state.set(() => {});
  await expect(page.getByTestId('pending-run')).toHaveCount(0);
  const completed = page.getByTestId('source').getByTestId('turn-activity');
  await expect(completed).toHaveAttribute('data-run-id', run.id);
  await expect(completed).toHaveAttribute('open', '');
  await expect(completed.locator(':scope > summary')).toContainText('본문 완료');
  expect(state.writes).toEqual([]);
  expect((await detail(request, seeded.chat.id)).runs).toEqual(seeded.runs);
});

test('TURNUI03 failed response without source keeps inline diagnostics readable at 390px', async ({
  page,
  request,
}, info) => {
  const seeded = await seed(request);
  const run = seeded.runs[0]!;
  const failure = `SYNTHETIC_CONTEXT_FAILURE:${'long-diagnostic-'.repeat(18)}`;
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await harness(page, seeded.chat.id, (body) => {
    body.sources = [];
    body.jobs = [];
    body.runs = body.runs.map((item) =>
      item.id === run.id
        ? { ...item, sourceRevision: null, status: 'failed', error: failure }
        : item
    );
    body.reader.responseActivity = [];
    body.reader.activity = [];
    body.reader.order = [];
    body.reader.navigation = [];
    body.reader.total = 0;
    body.reader.latest = null;
    body.reader.activeJobs = 0;
  });
  const pending = page.getByTestId('pending-run');
  await expect(pending).toHaveCount(1);
  const panel = pending.getByTestId('turn-activity');
  await expect(panel.locator(':scope > summary')).toContainText(/본문.*실패/);
  await expect(panel).not.toHaveAttribute('open');
  await panel.locator(':scope > summary').click();
  await expect(panel.getByText(failure, { exact: true })).toHaveCount(1);
  await expect(panel.getByText(failure, { exact: true })).toBeVisible();
  await expect(pending.getByRole('button', { name: '요청 다시 편집', exact: true })).toBeVisible();
  const bounds = await panel.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true
  );
  if (visualReview) await page.screenshot({ path: info.outputPath('turn-activity-mobile.png') });
  expect(state.writes).toEqual([]);
  expect((await detail(request, seeded.chat.id)).runs).toEqual(seeded.runs);
});
