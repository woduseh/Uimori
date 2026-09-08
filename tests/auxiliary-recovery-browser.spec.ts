import { test, expect } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import type { ChatDetail, Job, ReaderDetail } from '../core/types.js';

test('auxiliary failures show separate safe causes and recreate status with current settings', async ({
  page,
  request,
}, info) => {
  const chat = await (
    await postFixtureChat(request, { data: { title: 'Synthetic auxiliary recovery' } })
  ).json();
  const created = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: 'A synthetic lantern scene.',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: `auxiliary-ui-${chat.id}`,
    },
  });
  expect(created.ok()).toBeTruthy();
  let detail: ChatDetail;
  await expect
    .poll(async () => {
      detail = await (await request.get(`/api/chats/${chat.id}`)).json();
      return detail.runs[0]?.status;
    })
    .toBe('completed');
  const source = detail!.sources[0]!;
  const base = {
    chatId: chat.id,
    sourceRevision: source.id,
    sourceHash: source.hash,
    status: 'failed' as const,
    attempt: 1,
    result: null,
    revision: 1,
  };
  const jobs: Job[] = [
    { ...base, id: 'synthetic-status', kind: 'status', error: 'MODEL_REQUIRED:status' },
    {
      ...base,
      id: 'synthetic-translation',
      kind: 'translation',
      error: 'AUXILIARY_PROVIDER_HTTP_401',
      chunks: [
        { id: 'chunk-1', status: 'failed', attempt: 1, error: 'AUXILIARY_PROVIDER_HTTP_401' },
        { id: 'chunk-2', status: 'queued', attempt: 0, error: null },
      ],
    },
  ];
  // Only projected failure data and action responses are synthetic. Backend admission
  // and snapshot integrity are covered separately in prompt-settings.test.ts.
  await page.route(`**/api/chats/${chat.id}/reader?*`, async (route) => {
    const response = await route.fetch();
    const body: ReaderDetail = await response.json();
    body.jobs = jobs;
    await route.fulfill({ response, json: body });
  });
  let recoveryBody: unknown;
  await page.route(`**/api/sources/${source.id}/status`, async (route) => {
    recoveryBody = route.request().postDataJSON();
    await route.fulfill({ json: { ...jobs[0], id: 'synthetic-new-status', status: 'queued' } });
  });
  await page.route('**/api/jobs/synthetic-status/retry', async (route) => {
    await route.fulfill({ status: 409, json: { error: 'MODEL_REQUIRED:status' } });
  });
  await page.goto(`/?chat=${chat.id}`);
  const panel = page.getByTestId('turn-activity').first();
  await panel.locator(':scope > summary').click();
  const status = panel.getByTestId('job-status');
  const translation = panel.getByTestId('job-translation');
  await expect(status).toContainText('MODEL_REQUIRED:status');
  await expect(translation).toContainText('인증');
  await expect(translation).not.toContainText('표시 상태 모델');
  await translation.getByText('번역 구간별 상태', { exact: true }).click();
  await expect(translation.locator('li').first()).toContainText('AUXILIARY_PROVIDER_HTTP_401');
  await expect(translation.locator('li').nth(1)).toContainText('시도 0');
  await status.getByRole('button', { name: '이 작업만 재시도', exact: true }).click();
  await expect(
    page.getByText('장면 상태: 채팅 설정에서 표시 상태 모델을 선택해 주세요.', { exact: true })
  ).toBeVisible();
  await status.getByRole('button', { name: '현재 설정으로 장면 상태 새로 실행' }).click();
  await expect
    .poll(() => recoveryBody)
    .toEqual({ expectedSourceHash: source.hash, expectedJobId: 'synthetic-status' });
  await expect(
    page.getByText('장면 상태: 채팅 설정에서 표시 상태 모델을 선택해 주세요.', { exact: true })
  ).toHaveCount(0);
  expect(
    await translation.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
  ).toBe(true);
  await page.screenshot({ path: info.outputPath('auxiliary-recovery-mobile.png') });
  const after: ChatDetail = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(after.sources).toEqual(detail!.sources);
});
