import { postFixtureChat } from './fixtures/chat.js';
import { test, expect } from '@playwright/test';
import type { ReaderDetail } from '../core/types.js';

test('failed request edit, draft protection and uncertain retry reuse one admission', async ({
  page,
  request,
}, info) => {
  const response = await postFixtureChat(request, { data: { title: 'Synthetic retry' } });
  const chat = await response.json();
  await page.route(`**/api/chats/${chat.id}/reader?*`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as ReaderDetail;
    body.runs.push({
      id: 'synthetic-failure',
      chatId: chat.id,
      parentRevision: null,
      settingsRevision: 1,
      snapshot: { loreContextReset: true },
      request: '다시 쓸 합성 요청',
      status: 'failed',
      sourceRevision: null,
      error: 'Synthetic failure',
      usage: { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    });
    await route.fulfill({ response, json: body });
  });
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
  await page.screenshot({ path: info.outputPath('retry-mobile.png') });
  const payloads: Record<string, unknown>[] = [];
  await page.route(`**/api/chats/${chat.id}/runs`, async (route) => {
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
  expect(payloads[0].request).toBe('다시 쓸 합성 요청');
  expect(payloads[0].loreContextReset).toBe(true);
  await expect(input).toHaveValue('보존할 초안');
  await expect(page.getByRole('button', { name: '조회 로어 제외 해제' })).not.toBeVisible();
  const saved = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(saved.runs).toHaveLength(1);
  expect(saved.runs[0].request).toBe('다시 쓸 합성 요청');
  await expect(
    page.getByTestId('pending-run').filter({ hasText: 'Synthetic failure' })
  ).toBeVisible();
});
