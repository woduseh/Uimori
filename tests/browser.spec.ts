import { sourceAction } from './ui-navigation.js';
import { postFixtureChat } from './fixtures/chat.js';
import { test, expect, type Page, type APIRequestContext, type Request } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import type { Chat, ChatDetail } from '../core/types.js';

async function control(
  request: APIRequestContext,
  action: string,
  extra: Record<string, string> = {}
) {
  const response = await request.post('/api/test/control', { data: { action, ...extra } });
  expect(response.ok()).toBeTruthy();
}
async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  return (await request.get(`/api/chats/${id}`)).json();
}
async function newChat(page: Page, title: string): Promise<Chat> {
  const response = await postFixtureChat(page.request, { data: { title } });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as Chat;
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  return chat;
}
async function sourceDetails(page: Page) {
  await page.getByTestId('source').first().waitFor();
  for (const source of await page.getByTestId('source').all()) {
    const original = source.getByRole('button', { name: '원문 보기', exact: true });
    if (await original.count()) await original.click();
    const activity = source.getByTestId('turn-activity');
    if ((await activity.count()) && (await activity.getAttribute('open')) === null)
      await activity.locator(':scope > summary').click();
  }
}
async function expectSourceRaw(page: Page, text: string) {
  const source = page.getByTestId('source').first();
  await sourceAction(source, '원문 연결 정보');
  const dialog = page.getByRole('dialog', { name: '원문 연결 정보', exact: true });
  await dialog.getByText('현재 원문', { exact: true }).click();
  await expect(dialog.getByTestId('source-raw')).toHaveText(text);
  await dialog.getByRole('button', { name: '원문 연결 정보 닫기' }).click();
}
async function closeDialog(page: Page) {
  const dialog = page.getByRole('dialog').filter({ visible: true });
  if (await dialog.count()) await page.keyboard.press('Escape');
}
async function send(page: Page, prompt: string) {
  await closeDialog(page);
  await page.getByLabel('다음 장면 요청').fill(prompt);
  const response = page.waitForResponse(
    (r) => /\/api\/chats\/[^/]+\/runs$/.test(r.url()) && r.request().method() === 'POST'
  );
  await page.getByRole('button', { name: '원문 생성', exact: true }).click();
  await response;
}

test.afterEach(async ({ request }) => {
  await control(request, 'fixture', {});
  for (const barrier of ['run', 'translation']) await control(request, 'release', { barrier });
});

test('F05 failed auxiliary result retries independently while a later source is selected', async ({
  page,
  request,
}) => {
  const chat = await newChat(page, '합성 · 보조 재시도');
  await control(request, 'fail-next', { point: 'translation' });
  await send(page, 'SYNTHETIC_FIRST: A letter rests on the desk.');
  await expect(page.getByTestId('source')).toHaveCount(1);
  await page.getByRole('button', { name: '번역 생성', exact: true }).click();
  await sourceDetails(page);
  await expect(page.getByTestId('source').getByTestId('job-translation')).toContainText('실패');
  const before = await detail(request, chat.id);
  const source = before.sources[0];
  const failedJob = before.jobs.find((j) => j.kind === 'translation')!;
  await send(page, 'SYNTHETIC_SECOND: The letter remains sealed.');
  await expect(page.getByTestId('source')).toHaveCount(2);
  await sourceDetails(page);
  await control(request, 'hold', { barrier: 'translation' });
  await page
    .getByTestId('source')
    .getByTestId('job-translation')
    .filter({ hasText: '실패' })
    .getByRole('button', { name: '현재 설정으로 번역 다시 시도' })
    .click();
  await expect
    .poll(async () =>
      (await detail(request, chat.id)).jobs.some(
        (job) =>
          job.kind === 'translation' && job.sourceRevision === source.id && job.id !== failedJob.id
      )
    )
    .toBe(true);
  const retriedJob = (await detail(request, chat.id)).jobs.find(
    (job) => job.kind === 'translation' && job.sourceRevision === source.id
  )!;
  expect(retriedJob.id).not.toBe(failedJob.id);
  expect(retriedJob.revision).toBe(failedJob.revision! + 1);
  const repeated = await Promise.all([
    request.post(`/api/jobs/${failedJob.id}/retry`, { data: {} }),
    request.post(`/api/jobs/${failedJob.id}/retry`, { data: {} }),
  ]);
  for (const response of repeated) {
    expect(response.ok()).toBeTruthy();
    expect((await response.json()).id).toBe(retriedJob.id);
  }
  await control(request, 'release', { barrier: 'translation' });
  await expect
    .poll(
      async () =>
        (await detail(request, chat.id)).jobs.find((job) => job.id === retriedJob.id)?.status
    )
    .toBe('completed');
  const after = await detail(request, chat.id);
  expect(after.runs).toHaveLength(2);
  expect(after.sources.find((s) => s.id === source.id)).toEqual({
    ...source,
    translationRevision: source.translationRevision! + 1,
  });
  const later = after.sources.find((s) => s.id !== source.id)!;
  expect(later.parentRevision).toBe(source.id);
  expect(after.jobs.find((j) => j.id === retriedJob.id)?.sourceRevision).toBe(source.id);
  const db = new DatabaseSync(process.env.UIMORI_DB!, { readOnly: true });
  try {
    expect(db.prepare('SELECT status FROM jobs WHERE id=?').get(failedJob.id)?.status).toBe(
      'failed'
    );
  } finally {
    db.close();
  }
  expect(after.jobs.filter((j) => j.sourceRevision === source.id).map((j) => j.id)).toEqual([
    retriedJob.id,
  ]);
  expect(after.runs.find((r) => r.sourceRevision === later.id)?.inputs).toEqual([]);
  expect(after.sources.map((item) => item.id)).toContain(source.id);
});

test('F03 F05 an older real HTTP response cannot hide a newly committed source', async ({
  page,
  request,
}) => {
  const chat = await newChat(page, '합성 · 역순 응답');
  await page.goto('about:blank');
  const pending = new Set<Request>();
  const readerPath = `/api/chats/${chat.id}/reader`;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === readerPath && request.method() === 'GET')
      pending.add(request);
  });
  page.on('requestfinished', (request) => pending.delete(request));
  page.on('requestfailed', (request) => pending.delete(request));
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let captured!: () => void;
  const firstCaptured = new Promise<void>((resolve) => {
    captured = resolve;
  });
  let first = true;
  await page.route(`**${readerPath}?**`, async (route) => {
    if (!first || route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    first = false;
    const realResponse = await route.fetch();
    const realBody = await realResponse.body();
    captured();
    await barrier;
    await route.fulfill({
      status: realResponse.status(),
      body: realBody,
      headers: { ...realResponse.headers(), 'x-m0-delayed': 'true' },
    });
  });
  try {
    await page.goto(`/?chat=${chat.id}`, { waitUntil: 'domcontentloaded' });
    await firstCaptured;
    const response = await request.post(`/api/chats/${chat.id}/runs`, {
      data: {
        request: 'SYNTHETIC delayed HTTP response',
        expectedRevision: null,
        expectedSettingsRevision: chat.settingsRevision,
        idempotencyKey: 'reorder-source',
      },
    });
    expect(response.ok()).toBeTruthy();
    await expect(page.getByTestId('source')).toHaveCount(1);
    await page.getByRole('button', { name: '번역 생성', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await detail(request, chat.id)).jobs.some((job) => job.kind === 'translation') &&
          (await detail(request, chat.id)).jobs.every((j) => j.status === 'completed')
      )
      .toBe(true);
    const source = (await detail(request, chat.id)).sources[0];
    await sourceDetails(page);
    await expect(page.getByTestId('source').getByTestId('job-translation')).toContainText('완료');
    await expect.poll(() => pending.size).toBe(1);
    const delivered = page.waitForResponse((r) => r.headers()['x-m0-delayed'] === 'true');
    release();
    await (await delivered).finished();
    await expect.poll(() => pending.size).toBe(0);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    await page.getByLabel('다음 장면 요청').fill('local draft after the stale response');
    await expectSourceRaw(page, source.text);
    await sourceDetails(page);
    await expect(page.getByTestId('source').getByTestId('job-translation')).toContainText('완료');
  } finally {
    release();
    if (!page.isClosed())
      await page.unrouteAll({ behavior: 'ignoreErrors' }).catch((error) => {
        if (!page.isClosed()) throw error;
      });
  }
});
