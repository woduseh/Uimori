import { visualReview } from './fixtures/visual-review.js';
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
  await expect(translation).not.toContainText('장면 해설 모델');
  await expect(translation).toContainText('AUXILIARY_PROVIDER_HTTP_401');
  await status.getByRole('button', { name: '이 작업만 재시도', exact: true }).click();
  await expect(
    page.getByText('장면 해설: 전역 모델 설정에서 장면 해설 모델을 선택해 주세요.', { exact: true })
  ).toBeVisible();
  await status.getByRole('button', { name: '현재 설정으로 장면 해설 새로 실행' }).click();
  await expect
    .poll(() => recoveryBody)
    .toEqual({ expectedSourceHash: source.hash, expectedJobId: 'synthetic-status' });
  await expect(
    page.getByText('장면 해설: 전역 모델 설정에서 장면 해설 모델을 선택해 주세요.', { exact: true })
  ).toHaveCount(0);
  expect(
    await translation.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
  ).toBe(true);
  if (visualReview)
    await page.screenshot({ path: info.outputPath('auxiliary-recovery-mobile.png') });
  jobs[1].error = 'PROMPT_UNKNOWN_SLOT';
  await page.reload();
  const activity = page.getByTestId('turn-activity').first();
  await activity.locator(':scope > summary').click();
  const promptFailure = activity.getByTestId('job-translation');
  await expect(promptFailure).toContainText('PROMPT_UNKNOWN_SLOT');
  await expect(promptFailure).toContainText('입력 슬롯');
  await expect(promptFailure).toContainText('모델 전송 전');
  await expect(promptFailure).not.toContainText('인증');
  for (const [code, message] of [
    ['AUXILIARY_PROVIDER_PARTIAL', '모델 응답을 끝까지 받지 못했어요.'],
    ['AUXILIARY_PROVIDER_TIMEOUT', '제한 시간 안에 모델 응답을 완료하지 못했어요.'],
    ['AUXILIARY_PROVIDER_INPUT_CONTEXT_LIMIT_EXCEEDED', '요청이 모델의 입력 한도를 초과했어요.'],
  ]) {
    jobs[1].error = code;
    await page.reload();
    const activity = page.getByTestId('turn-activity').first();
    await expect(activity).toBeVisible();
    if (!(await activity.evaluate((element) => (element as HTMLDetailsElement).open)))
      await activity.locator(':scope > summary').click();
    const failure = activity.getByTestId('job-translation');
    await expect(failure.locator('.error')).toHaveCount(1);
    await expect(failure.getByRole('alert')).toContainText(message);
    await expect(failure).toContainText(code);
    await expect(failure).not.toContainText('구간을 자동');
    await expect(failure.getByRole('button', { name: '현재 설정으로 번역 재시도' })).toBeVisible();
  }
  const after: ChatDetail = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(after.sources).toEqual(detail!.sources);
});
