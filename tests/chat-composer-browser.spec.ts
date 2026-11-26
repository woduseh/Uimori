import { expect, test } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';

test('shared composer preserves Korean composition and Shift+Enter without sending', async ({
  page,
  request,
}) => {
  const created = await postFixtureChat(request, { data: { title: '입력창 키보드 합성 검사' } });
  expect(created.ok()).toBe(true);
  const chat = await created.json();
  await page.addInitScript(() => localStorage.setItem('uimori:enter-send', 'true'));
  await page.goto(`/?chat=${chat.id}`);
  const input = page.getByRole('textbox', { name: '다음 장면 요청' });
  await input.fill('한글 조합 중');
  await input.dispatchEvent('compositionstart');
  await input.press('Enter');
  await input.dispatchEvent('compositionend');
  await expect(input).toHaveValue('한글 조합 중\n');
  await input.fill('한글 입력');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 });
  await expect(input).toHaveValue('한글 입력');
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('한글 입력\n');
  await page.keyboard.insertText('가');
  await expect(input).toHaveValue('한글 입력\n가');
  const detail = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(detail.runs).toHaveLength(0);
  await expect(page.getByRole('button', { name: '원문 생성', exact: true })).toBeEnabled();
});
