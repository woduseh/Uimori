import { nativeProse, waitForNativeLayout } from './fixtures/native-message.js';
import { navigationAction, openChatMenu } from './ui-navigation.js';
import type { SceneUsageDetail } from '../core/scene-usage.js';
import type { ResponseStreamPage } from '../core/response-stream.js';
import { MOBILE_WIDTH, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { visualReview } from './fixtures/visual-review.js';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type {
  Chat,
  ChatDetail,
  ReaderActivity,
  ReaderDetail,
  ReaderRun,
  Run,
} from '../core/types.js';
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
        data: { ...chat.settings, expectedSettingsRevision: 1 },
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
              data: JSON.stringify({ kind: 'job.completed', seq: (event as CustomEvent).detail }),
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
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  const state = await harness(page, seeded.chat.id);
  const panels = page.getByTestId('source').getByTestId('turn-activity');
  await expect(panels).toHaveCount(2);
  const first = panels.nth(0);
  const second = panels.nth(1);
  await expect(first).not.toHaveAttribute('open');
  await expect(second).not.toHaveAttribute('open');
  await expect(first.locator(':scope > summary')).toContainText('본문 완료');
  await first.locator(':scope > summary').click();
  await expect(first).toHaveAttribute('open', '');
  await expect(second).not.toHaveAttribute('open');
  expect(state.runReads).toEqual([]);
  await second.scrollIntoViewIfNeeded();
  await expect(second).toBeInViewport();
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

for (const width of [320, MOBILE_WIDTH, 1440]) {
  test(`TURNUI06 expanded scene activity fills the available header width at ${width}px`, async ({
    page,
    request,
  }, info) => {
    const seeded = await seed(request);
    await page.setViewportSize({ width, height: 900 });
    const state = await harness(page, seeded.chat.id);
    const scene = page.getByTestId('source').first();
    const header = scene.locator('.scene-header');
    const activity = header.getByTestId('turn-activity');
    const summary = activity.locator(':scope > summary');
    const tools = header.locator('.scene-header-tools');
    await expect(activity).not.toHaveAttribute('open');
    await expect(tools).toBeVisible();
    await summary.click();
    await expect(activity).toHaveAttribute('open', '');
    const body = activity.locator(':scope > .turn-activity-body');
    await expect(body).toBeVisible();
    const headerBox = (await header.boundingBox())!;
    const summaryBox = (await summary.boundingBox())!;
    const bodyBox = (await body.boundingBox())!;
    const toolsBox = (await tools.boundingBox())!;
    expect(Math.abs(bodyBox.x - headerBox.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(bodyBox.width - headerBox.width)).toBeLessThanOrEqual(2);
    expect(bodyBox.y).toBeGreaterThanOrEqual(summaryBox.y + summaryBox.height);
    expect(toolsBox.x).toBeGreaterThanOrEqual(headerBox.x);
    expect(toolsBox.x + toolsBox.width).toBeLessThanOrEqual(headerBox.x + headerBox.width + 2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    if (width === MOBILE_WIDTH || width === 320)
      await page.screenshot({ path: info.outputPath(`expanded-scene-activity-${width}.png`) });
    await summary.click();
    await expect(activity).not.toHaveAttribute('open');
    expect(state.writes).toEqual([]);
  });
}

for (const width of [MOBILE_WIDTH, 1440]) {
  test(`TURNUI05 completed task history keeps adjacent lazy diagnostics and visible recovery states at ${width}px`, async ({
    page,
    request,
  }, info) => {
    const seeded = await seed(request);
    const run = seeded.runs[0]!;
    const attemptId = `task-history-display-${run.id}`;
    const sceneReads: string[] = [];
    // Rendering proof only: the durable run/source use the real app; known usage
    // and additional history states are controlled reader projections, not executions.
    await page.route(`**/api/chats/${seeded.chat.id}/reader-runs`, async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBeTruthy();
      const runs = (await response.json()) as ReaderRun[];
      const base: ReaderRun = {
        ...runs.find((item) => item.id === run.id)!,
        modelTitle: '호출 당시 작가 모델',
        contextSummary: {
          status: 'ready',
          inputTokenLimit: 65536,
          estimatedInputTokens: 1200,
          compactedSources: 3,
          summaryCalls: 1,
          error: null,
        },
        sceneUsage: {
          attemptId,
          inputTokens: 1234,
          outputTokens: 87,
          context: { estimatedInputTokens: 1200, inputTokenLimit: 65536 },
        },
      };
      const states: ReaderRun[] = (
        ['failed', 'partial', 'cancelled', 'refused', 'running'] as const
      ).map((status) => ({
        ...base,
        id: `${run.id}-${status}`,
        request: `표시 상태 확인: ${status}`,
        status,
        contextSummary: undefined,
        error: status === 'failed' ? 'SYNTHETIC_TASK_HISTORY_FAILURE' : null,
        partialText: status === 'partial' ? '보존한 미완성 원문' : undefined,
      }));
      for (const status of ['pending', 'failed'] as const)
        states.push({
          ...base,
          id: `${run.id}-context-${status}`,
          request: `완료된 작업의 컨텍스트 상태: ${status}`,
          contextSummary: {
            ...base.contextSummary!,
            status,
            error: status === 'failed' ? 'SYNTHETIC_CONTEXT_HISTORY_FAILURE' : null,
          },
        });
      await route.fulfill({ response, json: [base, ...states] });
    });
    await page.route(`**/api/attempts/${attemptId}/scene-detail`, async (route) => {
      sceneReads.push(route.request().url());
      await route.fulfill({
        json: {
          cache: { readTokens: 123, writeTokens: 45 },
          lore: null,
        } satisfies SceneUsageDetail,
      });
    });
    await page.setViewportSize({ width, height: 900 });
    const state = await harness(page, seeded.chat.id);
    await navigationAction(page, '작업 현황');
    const panel = page.getByRole('dialog', { name: '작업 현황', exact: true });
    const task = panel.locator(`[data-testid="run"][data-run-id="${run.id}"]`);
    const diagnostics = task.locator('.run-input-details');
    const usage = task.getByTestId('scene-usage');
    const execution = diagnostics.locator(':scope > .inspector');
    const usageSummary = usage.locator(':scope > summary');
    const executionSummary = execution.locator(':scope > summary');
    await expect(task.locator('.task-request')).toHaveText(run.request);
    await expect(task.locator('.task-heading')).toContainText('원문 완료');
    await expect(task.locator('.task-heading')).toContainText('호출 당시 작가 모델');
    await expect(task.getByRole('button', { name: '원고 읽기', exact: true })).toBeVisible();
    await expect(task.getByRole('button', { name: '새 채팅으로 복사', exact: true })).toBeVisible();
    await expect(diagnostics.locator(':scope > details')).toHaveCount(2);
    await expect(usageSummary).toHaveText('이번 생성');
    await expect(executionSummary).toHaveText('실행과 실제 입력 확인');
    await expect(usage).not.toHaveAttribute('open');
    await expect(execution).not.toHaveAttribute('open');
    await expect(task.getByText(/요청 1,234 · 응답 87 토큰/)).not.toBeVisible();
    await expect(task.getByTestId('context-summary')).not.toBeVisible();
    expect(sceneReads).toEqual([]);
    expect(state.runReads).toEqual([]);
    const left = await usageSummary.boundingBox();
    const right = await executionSummary.boundingBox();
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect(Math.abs(left!.y - right!.y)).toBeLessThanOrEqual(2);
    expect(left!.x + left!.width).toBeLessThanOrEqual(right!.x + 1);
    await page.screenshot({ path: info.outputPath(`task-history-compact-${width}.png`) });

    await usageSummary.click();
    await expect(usage.getByText(/요청 1,234 · 응답 87 토큰/)).toBeVisible();
    await expect(usage.getByText(/컨텍스트 사용량 1.9%/)).toBeVisible();
    await expect(
      usage.getByText('입력 1,234 / 컨텍스트 한도 65,536', { exact: true })
    ).toBeVisible();
    await expect(usage.getByText('캐시 읽기 123 / 쓰기 45 토큰', { exact: true })).toBeVisible();
    expect(sceneReads).toHaveLength(1);
    expect(state.runReads).toEqual([]);
    const groupBounds = await diagnostics.boundingBox();
    const usageBounds = await usage.boundingBox();
    expect(usageBounds!.width).toBeCloseTo(groupBounds!.width, 0);
    await usageSummary.click();
    await executionSummary.click();
    await expect(execution.locator('pre').last()).toContainText('snapshot');
    await expect(execution.getByTestId('context-summary')).toHaveText(
      '앞선 3개 원문 요약 · 입력 약 1,200 / 65,536 토큰 · 요약 1회'
    );
    expect(state.runReads).toHaveLength(1);
    const executionBounds = await execution.boundingBox();
    expect(executionBounds!.width).toBeCloseTo(groupBounds!.width, 0);
    await expect(task.locator('.task-request')).toHaveText(run.request);
    await expect(task.getByRole('button', { name: '원고 읽기', exact: true })).toBeVisible();
    await expect(task.getByRole('button', { name: '새 채팅으로 복사', exact: true })).toBeVisible();
    await executionSummary.click();

    for (const status of ['failed', 'partial', 'cancelled', 'refused', 'running']) {
      const other = panel.locator(`[data-testid="run"][data-run-id="${run.id}-${status}"]`);
      await expect(other.getByTestId('scene-usage').locator(':scope > summary')).toContainText(
        '이번 생성 · 요청 1,234 · 응답 87 토큰'
      );
      await expect(other.locator('.run-diagnostics-compact')).toHaveCount(0);
    }
    await expect(panel.getByText('SYNTHETIC_TASK_HISTORY_FAILURE', { exact: true })).toBeVisible();
    const partial = panel.locator(`[data-run-id="${run.id}-partial"] .partial-result`);
    await partial.locator(':scope > summary').click();
    await expect(partial.getByText('보존한 미완성 원문', { exact: true })).toBeVisible();
    await expect(partial.getByRole('button', { name: '출력 복사', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: '원문 생성 취소', exact: true })).toBeVisible();
    const pending = panel.locator(`[data-run-id="${run.id}-context-pending"]`);
    await expect(pending.getByTestId('context-summary')).toHaveText('컨텍스트 확인 중');
    await expect(pending.getByTestId('context-summary')).toBeVisible();
    const failed = panel.locator(`[data-run-id="${run.id}-context-failed"]`);
    await expect(failed.getByTestId('context-summary')).toContainText(
      'SYNTHETIC_CONTEXT_HISTORY_FAILURE'
    );
    await expect(failed.getByTestId('context-summary')).toBeVisible();
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    expect(sceneReads).toHaveLength(1);
    expect(state.runReads).toHaveLength(1);
    expect(state.writes).toEqual([]);
    expect((await detail(request, seeded.chat.id)).runs).toEqual(seeded.runs);
  });
}

test('TURNUI02 folded auxiliary progress updates preserve explicit expansion and ownership', async ({
  page,
  request,
}) => {
  const seeded = await seed(request, 2);
  const source = seeded.sources[0]!;
  const project = (status: 'running' | 'failed' | 'completed') => (body: ReaderDetail) => {
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
    body.jobs.push({
      ...body.jobs[0],
      id: `synthetic-status-${source.id}`,
      kind: 'status',
      revision: 2,
      error: status === 'failed' ? 'SYNTHETIC_STATUS_FAILURE' : null,
    });
    const illustrationActivity = activity(source.id, 'illustration', status);
    body.illustrations = [
      {
        id: illustrationActivity.id,
        task: 'plan',
        chatId: seeded.chat.id,
        sourceRevision: source.id,
        sourceHash: source.hash,
        generator: 'fixture',
        origin: 'manual',
        status,
        attempt: 1,
        maxAutoRetries: 0,
        error: status === 'failed' ? 'FIXTURE_FAILURE' : null,
        images: [],
        createdAt: illustrationActivity.createdAt,
        updatedAt: illustrationActivity.updatedAt,
      },
    ];
    body.reader.responseActivity = [
      activity(source.id, 'translation', status),
      activity(source.id, 'status', status),
      activity(source.id, 'illustration', status),
    ];
    if (status === 'completed')
      body.jobs.unshift({
        ...body.jobs.at(-1)!,
        id: `synthetic-previous-status-${source.id}`,
        revision: 1,
        status: 'stale',
      });
  };
  const state = await harness(page, seeded.chat.id, project('running'));
  const panel = page.locator(`[data-testid="turn-activity"][data-run-id="${source.runId}"]`);
  const otherSource = seeded.sources.find((item) => item.id !== source.id)!;
  const other = page.locator(`[data-testid="turn-activity"][data-run-id="${otherSource.runId}"]`);
  await expect(panel.locator(':scope > summary')).toContainText(/번역.*중/);
  await expect(panel.locator(':scope > summary')).not.toContainText('장면 해설');
  await expect(panel.locator(':scope > summary')).toContainText('장면 선택 중');
  await expect(panel.locator(':scope > summary')).toContainText('원문 이미지 배치 진행 중');
  await expect(panel.locator(':scope > summary')).toContainText('번역 이미지 배치 진행 중');
  await expect(panel).not.toHaveAttribute('open');
  await state.set(project('failed'));
  await expect(panel.locator(':scope > summary')).toContainText('번역 실패');
  await expect(panel.locator(':scope > summary')).toContainText('본문 완료');
  await expect(other.locator(':scope > summary')).not.toContainText('번역');
  await expect(other.locator(':scope > summary')).not.toContainText('장면 해설');
  await expect(panel).not.toHaveAttribute('open');
  await panel.locator(':scope > summary').click();
  await expect(panel.getByTestId('job-status')).toHaveCount(0);
  await expect(panel.getByRole('region', { name: '이 응답의 삽화 작업' })).toContainText(
    /장면 선택.*실패/s
  );
  await state.set(project('completed'));
  await expect(panel.locator(':scope > summary')).not.toContainText('실패');
  await expect(panel.locator(':scope > summary')).not.toContainText('이전 자료의 결과');
  await expect(panel).not.toHaveClass(/turn-activity-issue/);
  await expect(panel.getByTestId('job-status')).toHaveCount(0);
  await expect(panel.locator(`[data-job-id="synthetic-previous-status-${source.id}"]`)).toHaveCount(
    0
  );
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
    // The reader lists a source-less attempt only while it is an admitted pending run.
    body.reader.pendingRunIds = [run.id];
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

test(`TURNUI03 failed response without source keeps inline diagnostics readable at ${MOBILE_WIDTH}px`, async ({
  page,
  request,
}, info) => {
  const seeded = await seed(request);
  const run = seeded.runs[0]!;
  const failure = `SYNTHETIC_CONTEXT_FAILURE:${'long-diagnostic-'.repeat(18)}`;
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
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
    // The reader lists a source-less attempt only while it is an admitted pending run.
    body.reader.pendingRunIds = [run.id];
  });
  const pending = page.getByTestId('pending-run');
  await expect(pending).toHaveCount(1);
  const panel = pending.getByTestId('turn-activity');
  await expect(panel.locator(':scope > summary')).toContainText(/본문.*실패/);
  await expect(panel).not.toHaveAttribute('open');
  await panel.locator(':scope > summary').click();
  await expect(panel.getByText(failure, { exact: true })).toHaveCount(1);
  await expect(panel.getByText(failure, { exact: true })).toBeVisible();
  await expect(pending.getByRole('button', { name: '요청 편집', exact: true })).toBeVisible();
  const bounds = await panel.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  // Same bound as the other mobile panels: inside the viewport, with no scroll of its own.
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(MOBILE_WIDTH);
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  if (visualReview) await page.screenshot({ path: info.outputPath('turn-activity-mobile.png') });
  expect(state.writes).toEqual([]);
  expect((await detail(request, seeded.chat.id)).runs).toEqual(seeded.runs);
});

function pendingDisplay(body: ReaderDetail, status: Run['status']) {
  const run = body.runs[0];
  body.sources = [];
  body.jobs = [];
  body.runs = [
    {
      ...run,
      sourceRevision: null,
      status,
      error: status === 'refused' ? 'SYNTHETIC_REFUSAL' : null,
    },
  ];
  body.reader.pendingRunIds = [run.id];
  body.reader.responseActivity = [];
  body.reader.activity = [];
  body.reader.order = [];
  body.reader.navigation = [];
  body.reader.total = 0;
  body.reader.latest = null;
  body.reader.activeJobs = status === 'running' ? 1 : 0;
}

test('DISPLAY main complete mode waits for the canonical source across refresh and mode changes', async ({
  page,
  request,
}, info) => {
  const seeded = await seed(request),
    run = seeded.runs[0];
  await page.addInitScript(() => {
    if (!localStorage.getItem('uimori:response-display'))
      localStorage.setItem('uimori:response-display', 'complete');
  });
  let reads = 0;
  await page.route(`**/api/response-streams/main/${run.id}?*`, async (route) => {
    reads++;
    await route.fulfill({
      json: {
        taskKind: 'main',
        taskId: run.id,
        status: 'completed',
        cursor: 1,
        hasMore: false,
        chunks: [
          {
            seq: 1,
            segment: 0,
            attemptId: 'public',
            text: '후처리 전 공개 응답',
            offset: '후처리 전 공개 응답'.length,
          },
        ],
      } satisfies ResponseStreamPage,
    });
  });
  const state = await harness(page, seeded.chat.id, (body) => pendingDisplay(body, 'running'));
  const pending = page.getByTestId('pending-run');
  await expect(pending.getByTestId('turn-activity')).toContainText('장면을 쓰는 중');
  await expect(page.getByRole('button', { name: '원문 생성 취소', exact: true })).toBeVisible();
  await expect(pending.locator('.streaming-response')).toHaveCount(0);
  expect(reads).toBe(0);
  const mode = async (value: string) => {
    const menu = await openChatMenu(page);
    await menu.getByRole('button', { name: '읽기 설정', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '읽기 설정', exact: true });
    await dialog.getByLabel('응답 표시 방식', { exact: true }).selectOption(value);
    await page.keyboard.press('Escape');
  };
  await mode('stream');
  await expect(pending.locator('.streaming-text')).toHaveText('후처리 전 공개 응답');
  await mode('complete');
  await expect(pending.locator('.streaming-response')).toHaveCount(0);
  const previous = reads;
  await page.reload();
  await expect(pending).toBeVisible();
  await state.set((body) => pendingDisplay(body, 'completed'));
  await expect(pending).toContainText('결과 불러오는 중…');
  expect(reads).toBe(previous);
  await state.set(() => {});
  await expect(pending).toHaveCount(0);
  await expect(page.getByTestId('source')).toHaveCount(1);
  await waitForNativeLayout(page.getByTestId('source'));
  await expect(nativeProse(page.getByTestId('source'))).toContainText(
    'Synthetic scene 1: a lantern lights the quiet river.'
  );
  await expect(page.locator('.streaming-response')).toHaveCount(0);
  expect(reads).toBe(previous);
  expect(state.writes).toEqual([]);
  expect((await detail(request, seeded.chat.id)).sources).toEqual(seeded.sources);
  await page.screenshot({ path: info.outputPath('complete-main-canonical-source.png') });
});

test('DISPLAY main incomplete response fetches every page only after opening the disclosure', async ({
  page,
  request,
}, info) => {
  const seeded = await seed(request),
    run = seeded.runs[0];
  await page.addInitScript(() => localStorage.setItem('uimori:response-display', 'complete'));
  const cursors: number[] = [];
  let release = () => {};
  const secondPage = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/response-streams/main/${run.id}?*`, async (route) => {
    const after = Number(new URL(route.request().url()).searchParams.get('after') ?? 0);
    cursors.push(after);
    if (after) await secondPage;
    await route.fulfill({
      json: {
        taskKind: 'main',
        taskId: run.id,
        status: 'refused',
        cursor: after ? 2 : 1,
        hasMore: !after,
        chunks: [
          {
            seq: after ? 2 : 1,
            segment: 0,
            attemptId: 'public',
            text: after ? '와 마지막 부분' : '첫 부분',
            offset: after ? '첫 부분와 마지막 부분'.length : '첫 부분'.length,
          },
        ],
      } satisfies ResponseStreamPage,
    });
  });
  const state = await harness(page, seeded.chat.id, (body) => pendingDisplay(body, 'refused'));
  const pending = page.getByTestId('pending-run'),
    partial = pending.locator('.partial-response');
  await expect(partial).not.toHaveAttribute('open');
  expect(cursors).toEqual([]);
  await partial.locator('summary').click();
  try {
    await expect.poll(() => cursors.length).toBe(2);
    await expect(partial.locator('.streaming-text')).toHaveCount(0);
    await expect(partial).toContainText('일부 응답을 불러오는 중');
  } finally {
    release();
  }
  await expect(partial.locator('.streaming-text')).toHaveText('첫 부분와 마지막 부분');
  expect(cursors).toEqual([0, 1]);
  await page.screenshot({ path: info.outputPath('incomplete-main-open.png') });
  await page.reload();
  await expect(partial).not.toHaveAttribute('open');
  expect(cursors).toEqual([0, 1]);
  expect(state.writes).toEqual([]);
});
