import { test, expect } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import { nativeProse } from './fixtures/native-message.js';
import type { ChatDetail, Job } from '../core/types.js';

test('AUXREC translation failure retries from the reader without changing the source or draft', async ({
  page,
  request,
}) => {
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
  await scene.getByRole('button', { name: '번역 생성', exact: true }).click();
  const retry = scene.getByRole('button', { name: '번역 다시 시도', exact: true });
  await expect(retry).toBeVisible();
  await expect(scene.locator('.translation-placeholder')).toContainText(
    '한국어 번역을 완료하지 못했어요.'
  );
  const failed = (await read()).jobs.find((job) => job.kind === 'translation')!;
  expect(failed.status).toBe('failed');
  const savedFailure: Job = await (await request.get(`/api/jobs/${failed.id}`)).json();
  const draft = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
  await draft.fill('번역을 다시 시도해도 유지할 다음 장면 초안');

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
  } finally {
    release();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});
