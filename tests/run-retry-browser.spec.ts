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
  const failureCard = page.getByRole('group', { name: '실패한 요청', exact: true });
  await expect(failureCard).toBeVisible();
  const edit = page
    .getByTestId('pending-run')
    .getByRole('button', { name: '요청 편집', exact: true });
  const retry = failureCard.getByRole('button', { name: '다시 시도', exact: true });
  const input = page.getByRole('textbox', { name: '다음 장면 요청' });
  await input.fill('보존할 초안');
  await edit.click();
  const inline = page.getByRole('textbox', { name: '요청 수정 내용' });
  await expect(inline).toHaveValue('다시 쓸 합성 요청');
  await expect(inline).toBeFocused();
  await inline.fill('수정 중인 요청');
  await expect(input).toHaveValue('보존할 초안');
  await page.getByRole('button', { name: '요청 수정 취소' }).click();
  await expect(failureCard).toBeVisible();
  await expect(input).toHaveValue('보존할 초안');
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
  await expect(failureCard).toHaveCount(0);
  await page.reload();
  await expect(failureCard).toHaveCount(0);
  await expect(page.getByTestId('source-request')).toHaveCount(1);
  const saved = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(saved.runs).toHaveLength(2);
  const retried = saved.runs.find((run: { id: string }) => run.id !== failed.id);
  expect(retried.request).toBe('다시 쓸 합성 요청');
  expect(retried.snapshot.branchId).toBe(failed.snapshot.branchId);
  expect(retried.snapshot.loreContextReset).toBe(true);
  expect(new URL(page.url()).searchParams.get('branch')).toBeNull();
  await expect(input).toHaveValue('보존할 초안');
  expect(saved.runs.find((run: { id: string }) => run.id === failed.id).status).toBe('failed');
});

test('independent failed requests retain their positions when a later request succeeds', async ({
  page,
  request,
}) => {
  const chat = await (await postFixtureChat(request, { data: { title: 'Ordered retry' } })).json();
  const requests = ['첫 번째 실패 요청', '두 번째 실패 요청'];
  for (const text of requests) {
    expect(
      (
        await request.post('/api/test/control', {
          data: { action: 'fail-next', point: 'source-transaction' },
        })
      ).ok()
    ).toBe(true);
    const response = await request.post(`/api/chats/${chat.id}/runs`, {
      data: {
        request: text,
        expectedRevision: null,
        expectedSettingsRevision: chat.settingsRevision,
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(response.ok()).toBe(true);
    const run = await response.json();
    await expect
      .poll(
        async () =>
          (await (await request.get(`/api/chats/${chat.id}`)).json()).runs.find(
            (item: { id: string }) => item.id === run.id
          )?.status
      )
      .toBe('failed');
  }
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByTestId('source-request')).toHaveText(requests);
  const second = page.getByTestId('pending-run').filter({ hasText: requests[1] });
  await second.getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect
    .poll(async () => (await (await request.get(`/api/chats/${chat.id}`)).json()).sources.length)
    .toBe(1);
  await expect(page.getByTestId('source-request')).toHaveText(requests);
  await expect(page.getByRole('group', { name: '실패한 요청', exact: true })).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId('source-request')).toHaveText(requests);
  await expect(page.getByRole('group', { name: '실패한 요청', exact: true })).toHaveCount(1);
});
