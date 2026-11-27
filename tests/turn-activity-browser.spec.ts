import { nativeProse, waitForNativeLayout } from './fixtures/native-message.js';
import { openChatMenu } from './ui-navigation.js';
import type { ResponseStreamPage } from '../core/response-stream.js';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Chat, ChatDetail, ReaderDetail, Run } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';
import { visualReview } from './fixtures/visual-review.js';

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
  await expect(pending.getByTestId('turn-activity')).toBeVisible();
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
  if (visualReview)
    await page.screenshot({ path: info.outputPath('complete-main-canonical-source.png') });
});
