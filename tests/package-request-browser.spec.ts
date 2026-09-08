import { visualReview } from './fixtures/visual-review.js';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { createActionPackage } from './fixtures/action-package.js';
import type { ChatDetail } from '../core/types.js';

async function seed(request: APIRequestContext) {
  const pkg = createActionPackage(),
    saved = await request.post('/api/content', {
      data: {
        kind: 'bot',
        title: pkg.title,
        description: pkg.description,
        text: pkg.body,
        loading: 'pinned',
        relatedIds: [],
        package: pkg,
      },
    });
  expect(saved.ok(), await saved.text()).toBe(true);
  const content = await saved.json();
  const created = await request.post('/api/chats', {
    data: { title: 'Synthetic common package action UI', botId: content.id },
  });
  expect(created.ok(), await created.text()).toBe(true);
  return created.json() as Promise<{ id: string }>;
}
async function detail(request: APIRequestContext, id: string) {
  return (await (await request.get(`/api/chats/${id}`)).json()) as ChatDetail;
}

test('PREQUESTUI01 generic controls reserve a proposal, survive reload, consume once and cancel at 390px', async ({
  page,
  request,
}, info) => {
  const chat = await seed(request),
    endpoint = `/api/chats/${chat.id}/package-behaviors`,
    before = await detail(request, chat.id),
    errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?chat=${chat.id}`);
  const panel = page.getByRole('region', { name: '패키지 상태와 행동', exact: true });
  await expect(panel).toBeVisible();
  await panel.getByLabel('새 활력', { exact: true }).fill('150');
  await panel.getByRole('button', { name: '활력 설정', exact: true }).click();
  await expect
    .poll(async () => (await (await request.get(endpoint)).json()).instances[0].state.energy)
    .toBe(120);
  const text = 'Propose a bridge crossing, then wait for the user to choose.';
  await panel.getByLabel('장면 제안', { exact: true }).fill(text);
  await panel.getByRole('button', { name: '다음 탐험 예약', exact: true }).click();
  const pending = panel.getByRole('complementary', { name: '예약된 다음 요청', exact: true });
  await expect(pending).toContainText(text);
  const first = await (await request.get(endpoint)).json(),
    firstId = first.pendingRequest.id;
  const staged = await detail(request, chat.id);
  expect(staged.runs).toEqual(before.runs);
  expect(staged.sources).toEqual(before.sources);
  expect(staged.attempts).toEqual(before.attempts);
  await page.reload();
  await expect(pending).toContainText(text);
  expect((await (await request.get(endpoint)).json()).pendingRequest.id).toBe(firstId);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  if (visualReview)
    await pending.screenshot({ path: info.outputPath('package-request-mobile.png') });
  await pending.getByRole('button', { name: '작성란에 넣기', exact: true }).click();
  await expect(page.getByLabel('다음 장면 요청', { exact: true })).toHaveValue(text);
  await page.reload();
  await expect(page.getByLabel('다음 장면 요청', { exact: true })).toHaveValue(text);
  const accepted = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/chats/${chat.id}/runs`) &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: '원문 생성', exact: true }).click();
  const response = await accepted;
  expect(response.ok(), await response.text()).toBe(true);
  const run = await response.json();
  expect(response.request().postDataJSON().packageRequestId).toBe(firstId);
  await expect
    .poll(
      async () => (await detail(request, chat.id)).runs.find((item) => item.id === run.id)?.status
    )
    .toBe('completed');
  expect((await (await request.get(endpoint)).json()).pendingRequest).toBeNull();
  await expect(pending).toHaveCount(0);
  const after = await detail(request, chat.id);
  expect(after.runs).toHaveLength(before.runs.length + 1);
  expect(after.sources).toHaveLength(before.sources.length + 1);
  await expect(panel.getByRole('button', { name: '다음 탐험 예약', exact: true })).toBeEnabled();
  await panel.getByLabel('장면 제안', { exact: true }).fill('A different explicit proposal.');
  await panel.getByRole('button', { name: '다음 탐험 예약', exact: true }).click();
  await expect(pending).toContainText('A different explicit proposal.');
  await pending.getByRole('button', { name: '예약 취소', exact: true }).click();
  await expect(pending).toHaveCount(0);
  expect((await detail(request, chat.id)).runs).toEqual(after.runs);
  expect(errors).toEqual([]);
});

test('PREQUESTUI02 editing a staged proposal clears its receipt and cannot consume a different stored request', async ({
  page,
  request,
}) => {
  const chat = await seed(request),
    endpoint = `/api/chats/${chat.id}/package-behaviors`;
  await page.goto(`/?chat=${chat.id}`);
  const panel = page.getByRole('region', { name: '패키지 상태와 행동', exact: true });
  await panel.getByLabel('장면 제안', { exact: true }).fill('The original action proposal.');
  await panel.getByRole('button', { name: '다음 탐험 예약', exact: true }).click();
  const pending = panel.getByRole('complementary', { name: '예약된 다음 요청', exact: true });
  await expect(pending).toBeVisible();
  const original = (await (await request.get(endpoint)).json()).pendingRequest;
  await pending.getByRole('button', { name: '작성란에 넣기', exact: true }).click();
  await page
    .getByLabel('다음 장면 요청', { exact: true })
    .fill('An independently edited user request.');
  const accepted = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/chats/${chat.id}/runs`) &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: '원문 생성', exact: true }).click();
  const response = await accepted;
  expect(response.ok(), await response.text()).toBe(true);
  expect(response.request().postDataJSON()).not.toHaveProperty('packageRequestId');
  const run = await response.json();
  await expect
    .poll(
      async () => (await detail(request, chat.id)).runs.find((item) => item.id === run.id)?.status
    )
    .toBe('completed');
  expect((await (await request.get(endpoint)).json()).pendingRequest).toBeNull();
  const current = await detail(request, chat.id);
  const stale = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: original.request,
      packageRequestId: original.id,
      expectedRevision: current.chat.headRevision,
      expectedSettingsRevision: current.chat.settingsRevision,
      expectedProfileRevision: current.profile!.revision,
      idempotencyKey: crypto.randomUUID(),
    },
  });
  expect(stale.status()).toBe(409);
});
