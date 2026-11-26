import { nativeProse, waitForNativeLayout } from './fixtures/native-message.js';
import { openChatMenu } from './ui-navigation.js';
import type { ResponseStreamPage } from '../core/response-stream.js';
import { MOBILE_WIDTH } from './fixtures/browser-viewports.js';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Chat, ChatDetail, ReaderDetail, Run } from '../core/types.js';
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
  await page.addInitScript(() => {
    class SyntheticStream extends EventTarget {
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      closed = false;
      constructor() {
        super();
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

for (const width of [MOBILE_WIDTH]) {
  test(`TURNUI06 inspector keeps a failed translation recoverable in place and opens its task record at ${width}px`, async ({
    page,
    request,
  }) => {
    const seeded = await seed(request);
    const run = seeded.runs[0]!;
    const source = seeded.sources[0]!;
    const failedId = `inspector-failed-translation-${source.id}`;
    const retries: string[] = [];
    await page.route(`**/api/jobs/${failedId}/retry`, async (route) => {
      retries.push(route.request().method());
      await route.fulfill({ json: { ok: true } });
    });
    await page.setViewportSize({ width, height: 844 });
    const state = await harness(page, seeded.chat.id, (body) => {
      body.runs = body.runs.map((item) =>
        item.id === run.id
          ? {
              ...item,
              modelTitle: '아주 긴 이름을 가진 합성 장면 작가 모델 프리셋',
              sceneUsage: {
                inputTokens: 98765,
                outputTokens: 4321,
                context: { estimatedInputTokens: 98765, inputTokenLimit: 131072 },
                receipt: {
                  version: 1,
                  model: { modelId: 'synthetic-writer-with-a-long-id', title: '합성 작가' },
                  prompt: {
                    id: 'prompt',
                    revision: 1,
                    title: '아주 긴 한국어 프롬프트 프리셋 이름',
                  },
                  persona: null,
                  summary: { status: 'absent', coveredSources: 0 },
                },
              },
            }
          : item
      );
      const job = {
        chatId: seeded.chat.id,
        sourceRevision: source.id,
        sourceHash: source.hash,
        attempt: 1,
        result: null,
        revision: 1,
      };
      body.jobs = [
        {
          ...job,
          id: failedId,
          kind: 'translation',
          status: 'failed',
          error: 'AUXILIARY_PROVIDER_HTTP_401',
        },
        {
          ...job,
          id: `inspector-image-${source.id}`,
          kind: 'image',
          status: 'completed',
          error: null,
          imageTarget: { mode: 'original', textHash: source.hash },
        },
      ];
    });
    const panel = page.getByTestId('source').getByTestId('turn-activity');
    await expect(panel.locator(':scope > summary')).toContainText('번역 실패');
    await panel.locator(':scope > summary').click();
    const inspector = panel.getByTestId('scene-inspector');
    const translation = inspector.getByTestId('job-translation');
    await expect(translation).toHaveAttribute('data-tone', 'issue');
    await expect(translation.getByRole('alert')).toContainText('AUXILIARY_PROVIDER_HTTP_401');
    const image = inspector.getByTestId('job-image');
    await expect(image).toContainText('원문 이미지 배치');
    await expect(image.getByRole('button')).toHaveCount(0);
    await translation
      .getByRole('button', { name: '현재 설정으로 번역 다시 시도', exact: true })
      .click();
    await expect.poll(() => retries).toEqual(['POST']);
    await inspector.getByRole('button', { name: '작업 현황에서 보기', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '작업 현황', exact: true });
    await expect(dialog.getByTestId('run')).toHaveCount(1);
    const task = dialog.locator(`[data-testid="run"][data-run-id="${run.id}"]`);
    await expect(task.getByRole('button', { name: '접기', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    await dialog.getByRole('button', { name: '전체 작업 보기', exact: true }).click();
    await expect(dialog.locator('.task-history-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(state.writes).toEqual([expect.stringContaining(`/api/jobs/${failedId}/retry`)]);
  });
}

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
  for (const [phase, label] of [
    ['context', '컨텍스트를 정리하는 중'],
    ['lore', '로어를 고르는 중'],
    ['story-guide', '원작을 참고하는 중'],
    ['writing', '장면을 쓰는 중'],
  ] as const) {
    await state.set((body) => {
      pendingDisplay(body, 'running');
      body.runs[0].phase = phase;
    });
    await expect(pending.getByTestId('turn-activity')).toContainText(label);
  }
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
