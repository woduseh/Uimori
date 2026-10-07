import { visualReview } from './fixtures/visual-review.js';
import { test, expect } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import { nativeProse } from './fixtures/native-message.js';
import type { ChatDetail, Job, ReaderDetail } from '../core/types.js';

test('translation failures show safe causes while retired status jobs stay hidden', async ({
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
  try {
    await page.route(`**/api/chats/${chat.id}/reader?*`, async (route) => {
      const response = await route.fetch();
      const body: ReaderDetail = await response.json();
      body.jobs = jobs;
      await route.fulfill({ response, json: body });
    });
    await page.goto(`/?chat=${chat.id}`);
    const panel = page.getByTestId('turn-activity').first();
    await panel.locator(':scope > summary').click();
    await expect(panel.getByTestId('job-status')).toHaveCount(0);
    const translation = panel.getByTestId('job-translation');
    await expect(translation).toContainText('인증');
    await expect(translation).toContainText('AUXILIARY_PROVIDER_HTTP_401');
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
      await expect(
        failure.getByRole('button', { name: '현재 설정으로 번역 재시도' })
      ).toBeVisible();
    }
    jobs[1].error = 'TRANSLATION_REFUSAL_CHECK_FAILED';
    jobs[1].result = {
      mock: false,
      sourceRevision: source.id,
      sourceHash: source.hash,
      text: 'Saved translation',
    };
    let judgmentRequests = 0;
    await page.route('**/api/jobs/synthetic-translation/rejudge', async (route) => {
      expect(route.request().postDataJSON()).toEqual({});
      judgmentRequests++;
      await route.fulfill({
        json: { ...jobs[1], id: 'synthetic-judgment-recovery', status: 'queued' },
      });
    });
    await page.reload();
    const recoveredActivity = page.getByTestId('turn-activity').first();
    if (!(await recoveredActivity.evaluate((element) => (element as HTMLDetailsElement).open)))
      await recoveredActivity.locator(':scope > summary').click();
    await recoveredActivity
      .getByRole('button', { name: '번역 판정만 다시 시도', exact: true })
      .click();
    await expect.poll(() => judgmentRequests).toBe(1);
    const after: ChatDetail = await (await request.get(`/api/chats/${chat.id}`)).json();
    expect(after.sources).toEqual(detail!.sources);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('AUXREC translation failure retries from the reader without changing the source or draft', async ({
  page,
  request,
}, info) => {
  const chat = await (
    await postFixtureChat(request, { data: { title: 'Translation placeholder recovery' } })
  ).json();
  const created = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: 'Synthetic placeholder translation source.',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: `translation-placeholder-${chat.id}`,
    },
  });
  expect(created.ok()).toBe(true);
  const read = async (): Promise<ChatDetail> => (await request.get(`/api/chats/${chat.id}`)).json();
  await expect.poll(async () => (await read()).runs[0]?.status).toBe('completed');
  const original = await read();
  const source = original.sources[0];
  expect(
    (
      await request.post('/api/test/control', {
        data: { action: 'fail-next', point: 'translation' },
      })
    ).ok()
  ).toBe(true);
  await page.goto(`/?chat=${chat.id}`);
  const scene = page.locator(`[data-testid="source"][data-source-id="${source.id}"]`);
  await scene.getByRole('button', { name: '번역 보기', exact: true }).click();
  const retry = scene.getByRole('button', { name: '번역 다시 시도', exact: true });
  await expect(retry).toBeVisible();
  await expect(scene.locator('.translation-placeholder')).toContainText('원문은 보존돼요.');
  const failed = (await read()).jobs.find((job) => job.kind === 'translation')!;
  expect(failed.status).toBe('failed');
  const savedFailure: Job = await (await request.get(`/api/jobs/${failed.id}`)).json();
  const draft = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
  await draft.fill('번역을 다시 시도해도 유지할 다음 장면 초안');
  if (visualReview)
    await page.screenshot({ path: info.outputPath('translation-placeholder-failed.png') });

  let retryRequests = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/sources/${source.id}/translation`, async (route) => {
    retryRequests++;
    await gate;
    await route.fulfill({ response: await route.fetch() });
  });
  try {
    await retry.click();
    await expect(retry).toBeDisabled();
    // A repeated activation while admission is pending must not create another request.
    await retry.dispatchEvent('click');
    expect(retryRequests).toBe(1);
    release();
    const translated = nativeProse(scene.getByTestId('translation-text'));
    await expect(translated).toContainText('Synthetic placeholder translation source.');
    await expect(retry).toHaveCount(0);
    await expect(draft).toHaveValue('번역을 다시 시도해도 유지할 다음 장면 초안');
    const after = await read();
    const completed = after.jobs.find((job) => job.kind === 'translation')!;
    expect(completed.status).toBe('completed');
    expect(completed.id).not.toBe(failed.id);
    expect(completed.revision).toBe(failed.revision! + 1);
    expect(completed.sourceRevision).toBe(source.id);
    expect(completed.sourceHash).toBe(source.hash);
    expect(after.sources).toEqual([{ ...source, translationRevision: completed.revision }]);
    expect(after.runs).toEqual(original.runs);
    expect(await (await request.get(`/api/jobs/${failed.id}`)).json()).toMatchObject({
      status: savedFailure.status,
      error: savedFailure.error,
      result: savedFailure.result,
    });
    expect(retryRequests).toBe(1);
    if (visualReview)
      await page.screenshot({ path: info.outputPath('translation-placeholder-recovered.png') });
  } finally {
    release();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});
