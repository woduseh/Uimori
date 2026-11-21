import { DESKTOP_HEIGHT, DESKTOP_WIDTH, MOBILE_WIDTH } from './fixtures/browser-viewports.js';
import { expect, test } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import { openHelper } from './ui-navigation.js';

test('NOTICE composer menu restores focus and draft after closing the persona picker', async ({
  page,
  request,
}) => {
  const created = await postFixtureChat(request, { data: { title: '메뉴 안내 정렬 검사' } });
  expect(created.ok()).toBe(true);
  const chat = await created.json();
  await page.goto(`/?chat=${chat.id}`);
  const input = page.getByRole('textbox', { name: '다음 장면 요청' });
  await input.fill('메뉴를 열어도 보존할 초안');
  await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
  const menu = page.getByRole('group', { name: '이번 요청 옵션' });
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
  for (const height of [590, 490, 844]) {
    await page.setViewportSize({ width: MOBILE_WIDTH, height });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const shell = document.querySelector('.app-shell')!.getBoundingClientRect();
          const dock = document.querySelector('.composer-dock')!.getBoundingClientRect();
          const input = document.querySelector<HTMLTextAreaElement>('#request')!;
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

test('shared composer shrinks nonempty drafts in main and helper without width oscillation', async ({
  page,
  request,
}) => {
  const created = await postFixtureChat(request, { data: { title: '입력창 축소 합성 검사' } });
  expect(created.ok()).toBe(true);
  const chat = await created.json();
  const observerErrors: string[] = [];
  page.on('pageerror', (error) => {
    if (/ResizeObserver/u.test(error.message)) observerErrors.push(error.message);
  });
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
        Math.abs((await form.evaluate((node) => node.getBoundingClientRect().height)) - shortHeight)
      )
      .toBeLessThanOrEqual(1);
    await expect(input).toHaveValue('짧은 요청');
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
  expect(observerErrors).toEqual([]);
  expect((await (await request.get(`/api/chats/${chat.id}`)).json()).runs).toHaveLength(0);
});

test('shared composer typing leaves the reader, scene rail and sidebar unrendered', async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    const rendered: Element[] = [];
    const firstHost = (fiber: any): Element | null => {
      for (let node = fiber.child; node; node = node.child)
        if (node.tag === 5) return node.stateNode;
      return null;
    };
    const visit = (next: any, previous: any) => {
      if ([0, 11, 15].includes(next.tag) && (previous === null || next.flags & 1)) {
        const host = firstHost(next);
        if (host) rendered.push(host);
      }
      if (previous !== null && next.child === previous.child) return;
      for (let child = next.child; child; child = child.sibling)
        visit(child, previous === null ? null : child.alternate);
    };
    Object.assign(window, {
      __renderedHosts: rendered,
      __REACT_DEVTOOLS_GLOBAL_HOOK__: {
        supportsFiber: true,
        renderers: new Map(),
        inject: () => 1,
        checkDCE: () => {},
        onCommitFiberRoot: (_id: number, root: any) => visit(root.current, root.current.alternate),
        onCommitFiberUnmount: () => {},
        onPostCommitFiberRoot: () => {},
      },
    });
  });
  const created = await postFixtureChat(request, { data: { title: '입력 렌더 범위 검사' } });
  expect(created.ok()).toBe(true);
  const chat = await created.json();
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
  await page.goto(`/?chat=${chat.id}`);
  const input = page.getByRole('textbox', { name: '다음 장면 요청' });
  await input.fill('첫 장면을 열어 주세요.');
  const received = page.waitForResponse(
    (response) =>
      /\/api\/chats\/[^/]+\/runs$/.test(response.url()) && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: '원문 생성', exact: true }).click();
  const run = await (await received).json();
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/chats/${chat.id}`)).json()).runs.find(
          (item: { id: string }) => item.id === run.id
        )?.status
    )
    .toBe('completed');
  await expect(page.locator('[data-reader-scrollport] [data-testid="source"]')).toHaveCount(1);
  await expect(page.locator('[data-reader-scrollport] [data-testid="source-text"]')).toBeVisible();
  await expect(page.locator('.scene-navigator')).toBeVisible();
  await input.fill('다음');
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const regions = {
    reader: '[data-reader-scrollport]',
    scenes: '.scene-navigator',
    sidebar: '#workspace-sidebar',
    composer: 'form.composer',
  };
  await page.evaluate(() => {
    (window as unknown as { __renderedHosts: Element[] }).__renderedHosts.length = 0;
  });
  await input.pressSequentially(' 장면');
  await expect(input).toHaveValue('다음 장면');
  const counts = await page.evaluate((selectors) => {
    const hosts = (window as unknown as { __renderedHosts: Element[] }).__renderedHosts;
    return Object.fromEntries(
      Object.entries(selectors).map(([name, selector]) => [
        name,
        hosts.filter((host) => host.isConnected && host.closest(selector)).length,
      ])
    );
  }, regions);
  expect(counts.composer).toBeGreaterThan(0);
  expect({ ...counts, composer: 0 }).toEqual({ reader: 0, scenes: 0, sidebar: 0, composer: 0 });
});

test('main composer names the macOS modifier in its send-key labels', async ({ page, request }) => {
  const created = await postFixtureChat(request, { data: { title: 'macOS 전송 키 표기 검사' } });
  expect(created.ok()).toBe(true);
  const chat = await created.json();
  await page.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' })
  );
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
  await page.goto(`/?chat=${chat.id}`);
  const input = page.getByRole('textbox', { name: '다음 장면 요청' });
  await expect(input).toHaveAttribute(
    'placeholder',
    '다음 장면 요청을 입력하세요… (Cmd+Enter 보내기)'
  );
  await input.fill('맥 표기 확인');
  await expect(page.getByRole('button', { name: '원문 생성', exact: true })).toHaveAttribute(
    'title',
    '보내기 (Cmd+Enter)'
  );
});
