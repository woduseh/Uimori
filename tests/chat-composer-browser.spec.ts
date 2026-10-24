import { MOBILE_WIDTH, DESKTOP_WIDTH, DEFAULT_WIDTHS } from './fixtures/browser-viewports.js';
import { expect, test } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import { openHelper } from './ui-navigation.js';
import { visualReview } from './fixtures/visual-review.js';

for (const width of DEFAULT_WIDTHS) {
  test(`NOTICE composer menu restores focus and draft after closing the persona picker at ${width}px`, async ({
    page,
    request,
  }, info) => {
    const created = await postFixtureChat(request, { data: { title: '메뉴 안내 정렬 검사' } });
    expect(created.ok()).toBe(true);
    const chat = await created.json();
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?chat=${chat.id}`);
    const input = page.getByRole('textbox', { name: '다음 장면 요청' });
    await input.fill('메뉴를 열어도 보존할 초안');
    await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
    const menu = page.getByRole('group', { name: '이번 요청 옵션' });
    await page.screenshot({ path: info.outputPath(`composer-menu-${width}.png`) });
    await menu.getByRole('button', { name: '빠른 페르소나' }).click();
    const picker = page.getByRole('dialog', { name: '빠른 페르소나', exact: true });
    await expect(picker).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '입력창 더보기', exact: true })).toBeFocused();
    await expect(input).toHaveValue('메뉴를 열어도 보존할 초안');
    expect((await (await request.get(`/api/chats/${chat.id}`)).json()).runs).toHaveLength(0);
  });
}

test('short mobile composer menu keeps context controls reachable', async ({ page, request }) => {
  const created = await postFixtureChat(request, { data: { title: '짧은 화면 메뉴 검사' } });
  expect(created.ok()).toBe(true);
  const chat = await created.json();
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 540 });
  await page.goto(`/?chat=${chat.id}`);
  await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
  const menu = page.getByRole('group', { name: '이번 요청 옵션' });
  const frame = await menu.boundingBox();
  expect(frame).not.toBeNull();
  expect(frame!.y).toBeGreaterThanOrEqual(0);
  expect(frame!.y + frame!.height).toBeLessThanOrEqual(540);
  const loreReset = menu.getByRole('switch', { name: '다음 생성에서 조회 로어 제외' });
  await loreReset.scrollIntoViewIfNeeded();
  await expect(loreReset).toBeInViewport();
  await loreReset.click();
  await expect(page.getByRole('button', { name: '조회 로어 제외 해제' })).toBeVisible();
});

test('shared composer follows resized content viewport while preserving the draft', async ({
  page,
  request,
}) => {
  const created = await postFixtureChat(request, { data: { title: '모바일 키보드 영역 검사' } });
  expect(created.ok()).toBe(true);
  const chat = await created.json();
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  await page.goto(`/?chat=${chat.id}`);
  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(viewport).toContain('interactive-widget=resizes-content');

  const input = page.getByRole('textbox', { name: '다음 장면 요청' });
  const draft = '키보드가 열린 상태에서도 보존할 요청\n'.repeat(5);
  await input.fill(draft);
  await expect(page.locator('.composer-dock .composer')).toHaveClass(/grown/u);
  // Desktop emulation cannot raise an Android IME. Simulate the layout viewport
  // shrinking/restoring, as requested by interactive-widget=resizes-content.
  for (const height of [590, 490, 844]) {
    await page.setViewportSize({ width: MOBILE_WIDTH, height });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const shell = document.querySelector('.app-shell')!.getBoundingClientRect();
          const dock = document.querySelector('.composer-dock')!.getBoundingClientRect();
          const input = document.querySelector<HTMLTextAreaElement>('#request')!;
          // Matching the dock to a wrongly shortened shell would miss the blank gap.
          return Math.max(
            Math.abs(shell.bottom - window.innerHeight),
            Math.abs(dock.bottom - window.innerHeight),
            Math.max(0, -input.getBoundingClientRect().top)
          );
        })
      )
      .toBeLessThanOrEqual(2);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(draft);
  }
});

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
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
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
  await input.fill('아직 보내지 않은 합성 요청');
  await expect(input).toBeInViewport();
  const model = page.getByRole('button', { name: /^현재 본문 모델/ });
  const submit = page.getByRole('button', { name: '원문 생성', exact: true });
  for (const button of [model, submit]) {
    await expect(button).toBeInViewport();
    expect(
      await button.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return hit === node || node.contains(hit);
      })
    ).toBe(true);
  }
  const persona = page.getByRole('button', { name: '빠른 페르소나', exact: true });
  await expect(persona).toHaveCount(0);
  await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
  await expect(page.getByRole('button', { name: '창작 옵션', exact: true })).toBeVisible();
  await expect(persona).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(input).toHaveValue('아직 보내지 않은 합성 요청');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await (await request.get(`/api/chats/${chat.id}`)).json()).runs).toHaveLength(0);
  expect(errors).toEqual([]);
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
