import { MOBILE_WIDTH, DESKTOP_WIDTH, DEFAULT_WIDTHS } from './fixtures/browser-viewports.js';
import { expect, test } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import { openHelper } from './ui-navigation.js';
import { visualReview } from './fixtures/visual-review.js';

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

test('shared composer grows at narrow widths and resets after clearing', async ({
  page,
  request,
}) => {
  const created = await postFixtureChat(request, { data: { title: '입력창 크기 합성 검사' } });
  expect(created.ok()).toBe(true);
  const chat = await created.json();
  const observerErrors: string[] = [];
  page.on('pageerror', (error) => {
    if (/ResizeObserver/u.test(error.message)) observerErrors.push(error.message);
  });
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  const input = page.getByRole('textbox', { name: '다음 장면 요청' });
  const form = page.locator('form.composer').filter({ has: input });
  await expect(input).toBeVisible();
  await input.fill('짧은 요청');
  await expect(form).not.toHaveClass(/grown/u);
  await input.fill('장면의 인물과 배경을 이어서 묘사해 주세요. '.repeat(25));
  await expect(form).toHaveClass(/grown/u);
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  await expect
    .poll(async () => input.evaluate((node) => node.getBoundingClientRect().height))
    .toBeLessThanOrEqual(180);
  await expect
    .poll(async () => input.evaluate((node) => node.scrollHeight > node.clientHeight))
    .toBe(true);
  await expect
    .poll(async () =>
      form.evaluate((node) => node.getBoundingClientRect().right <= window.innerWidth)
    )
    .toBe(true);
  await input.fill('');
  await expect(form).not.toHaveClass(/grown/u);
  await expect
    .poll(async () => input.evaluate((node) => node.getBoundingClientRect().height))
    .toBeLessThanOrEqual(48);
  expect(observerErrors).toEqual([]);
});

test('shared composer shrinks nonempty drafts in main and helper without width oscillation', async ({
  page,
  request,
}, info) => {
  const created = await postFixtureChat(request, { data: { title: '입력창 축소 합성 검사' } });
  expect(created.ok()).toBe(true);
  const chat = await created.json();
  const observerErrors: string[] = [];
  page.on('pageerror', (error) => {
    if (/ResizeObserver/u.test(error.message)) observerErrors.push(error.message);
  });
  for (const width of DEFAULT_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?chat=${chat.id}`);
    for (const target of ['main', 'helper']) {
      if (target === 'helper') await openHelper(page);
      const input =
        target === 'main'
          ? page.getByRole('textbox', { name: '다음 장면 요청' })
          : page.getByRole('textbox', { name: '도우미에게 요청' });
      const form = page.locator('form.composer').filter({ has: input });
      await input.fill('짧은 요청');
      await expect(form).not.toHaveClass(/grown/u);
      const shortHeight = await form.evaluate((node) => node.getBoundingClientRect().height);
      await input.fill('장면의 인물과 배경을 이어서 묘사해 주세요. '.repeat(25));
      await expect(form).toHaveClass(/grown/u);
      await input.fill('짧은 요청');
      await expect(form).not.toHaveClass(/grown/u);
      await expect
        .poll(async () =>
          Math.abs(
            (await form.evaluate((node) => node.getBoundingClientRect().height)) - shortHeight
          )
        )
        .toBeLessThanOrEqual(1);
      await expect(input).toHaveValue('짧은 요청');
      if (visualReview)
        await page.screenshot({ path: info.outputPath(`composer-shrink-${target}-${width}.png`) });
      // A draft that first wraps at the narrow one-row width must keep its chosen shape,
      // even if it fits in one line after the action controls move below it.
      for (let length = 8; length <= 120; length += 4) {
        await input.fill('가'.repeat(length));
        const states = await form.evaluate(async (node) => {
          const states = [];
          for (let i = 0; i < 4; i++) {
            await new Promise(requestAnimationFrame);
            states.push(node.classList.contains('grown'));
          }
          return states;
        });
        expect(new Set(states).size).toBe(1);
        if (states[0]) break;
      }
      await input.fill('');
    }
  }
  expect(observerErrors).toEqual([]);
  expect((await (await request.get(`/api/chats/${chat.id}`)).json()).runs).toHaveLength(0);
});
