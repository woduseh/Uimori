import { visualReview } from './fixtures/visual-review.js';
import { postFixtureChat } from './fixtures/chat.js';
import { test, expect } from '@playwright/test';

test('failed request edit, draft protection and uncertain retry reuse one admission', async ({
  page,
  request,
}, info) => {
  const response = await postFixtureChat(request, { data: { title: 'Synthetic retry' } });
  const chat = await response.json();
  expect(
    (
      await request.post('/api/test/control', {
        data: { action: 'fail-next', point: 'source-transaction' },
      })
    ).ok()
  ).toBe(true);
  const failedResponse = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: '다시 쓸 합성 요청',
      loreContextReset: true,
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: crypto.randomUUID(),
    },
  });
  expect(failedResponse.ok()).toBe(true);
  const failed = await failedResponse.json();
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/chats/${chat.id}`)).json()).runs.find(
          (run: { id: string }) => run.id === failed.id
        )?.status
    )
    .toBe('failed');
  await page.goto(`/?chat=${chat.id}`);
  await page
    .getByTestId('pending-run')
    .getByTestId('turn-activity')
    .locator(':scope > summary')
    .click();
  const edit = page.getByRole('button', { name: '요청 다시 편집' });
  const retry = page.getByRole('button', { name: '현재 설정으로 재시도' });
  const input = page.getByRole('textbox', { name: '다음 장면 요청' });
  await edit.click();
  await expect(input).toHaveValue('다시 쓸 합성 요청');
  await expect(input).toBeFocused();
  await expect(page.getByRole('button', { name: '조회 로어 제외 해제' })).toBeVisible();
  await input.fill('보존할 초안');
  page.once('dialog', (dialog) => dialog.dismiss());
  await edit.click();
  await expect(input).toHaveValue('보존할 초안');
  await page.getByRole('button', { name: '조회 로어 제외 해제' }).click();
  if (visualReview) await page.screenshot({ path: info.outputPath('retry-mobile.png') });
  const payloads: Record<string, unknown>[] = [];
  await page.route(`**/api/runs/${failed.id}/retry`, async (route) => {
    payloads.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (payloads.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await retry.click();
  await expect(page.getByRole('button', { name: '이전 요청 확인' })).toBeVisible();
  await expect(retry).toBeDisabled();
  await expect(input).toHaveValue('보존할 초안');
  await page.reload();
  await page.getByRole('button', { name: '이전 요청 확인' }).click();
  await expect(page.getByRole('button', { name: '원문 생성', exact: true })).toBeVisible();
  expect(payloads).toHaveLength(2);
  expect(payloads[1]).toEqual(payloads[0]);
  expect(Object.keys(payloads[0])).toEqual(['idempotencyKey']);
  expect(await page.evaluate((id) => sessionStorage.getItem(`draft:${id}`), chat.id)).toBe(
    '보존할 초안'
  );
  await expect(page.getByRole('button', { name: '조회 로어 제외 해제' })).not.toBeVisible();
  const saved = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(saved.runs).toHaveLength(2);
  const retried = saved.runs.find((run: { id: string }) => run.id !== failed.id);
  expect(retried.request).toBe('다시 쓸 합성 요청');
  expect(new URL(page.url()).searchParams.get('branch')).toBe(retried.snapshot.branchId);
  expect(saved.runs.find((run: { id: string }) => run.id === failed.id).status).toBe('failed');
});
