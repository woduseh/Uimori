import { MOBILE_WIDTH, DEFAULT_WIDTHS } from './fixtures/browser-viewports.js';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { fixtureBotInput } from './fixtures/chat.js';
import {
  navigationAction,
  openHelper,
  selectSettingsSection,
  visibleNavigation,
} from './ui-navigation.js';

for (const width of DEFAULT_WIDTHS) {
  test(`SIDENAV01 settings and direct workspace navigation stay accessible at ${width}px`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const navigation = await visibleNavigation(page);
    const destinations = navigation.getByRole('navigation', { name: '작업 공간', exact: true });
    const footer = navigation.getByRole('navigation', { name: '앱 탐색', exact: true });
    const settings = footer.getByRole('button', { name: '설정', exact: true });
    const library = destinations.getByRole('button', { name: '서재', exact: true });
    const prompts = destinations.getByRole('button', { name: '프롬프트', exact: true });
    await expect(destinations.getByRole('button')).toHaveText(['서재', '프롬프트']);
    const footerBox = await footer.boundingBox();
    const settingsBox = await settings.boundingBox();
    expect(footerBox).not.toBeNull();
    expect(settingsBox).not.toBeNull();
    if (!footerBox || !settingsBox) throw new Error('Sidebar footer has no visible bounds');
    expect(Math.abs(settingsBox.width - footerBox.width)).toBeLessThanOrEqual(1);
    for (const action of [library, prompts, settings]) {
      await expect(action).toBeVisible();
      await expect(action).toBeInViewport();
      const box = await action.boundingBox();
      expect(box).not.toBeNull();
      if (!box) throw new Error('Sidebar action has no visible bounds');
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    }
    await page.screenshot({ path: info.outputPath(`sidebar-footer-${width}.png`) });

    await library.focus();
    await page.keyboard.press('Tab');
    await expect(prompts).toBeFocused();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`sidebar-menu-${width}.png`) });
    if (width === MOBILE_WIDTH) {
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: '탐색', exact: true })).toBeHidden();
      await expect(page.getByRole('button', { name: '탐색 메뉴', exact: true })).toBeFocused();
      await visibleNavigation(page);
    }

    await settings.click();
    const dialog = page.getByRole('dialog', { name: '설정', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '설정 닫기', exact: true }).click();
    await expect(dialog).toBeHidden();
    for (const destination of ['프롬프트', '서재']) {
      const current = await visibleNavigation(page);
      await current.getByRole('button', { name: destination, exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: destination, exact: true })).toBeVisible();
      if (width === MOBILE_WIDTH)
        await expect(page.getByRole('dialog', { name: '탐색', exact: true })).toBeHidden();
      const returned = await visibleNavigation(page);
      await expect(
        returned.getByRole('button', { name: destination, exact: true })
      ).toHaveAttribute('aria-current', 'page');
      await expect(returned.getByRole('button', { name: '설정', exact: true })).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
}

async function sidebarFixture(request: APIRequestContext) {
  const created = await request.post('/api/content', {
    data: fixtureBotInput('밤의 도서관 · 긴 이름의 이야기'),
  });
  expect(created.ok()).toBe(true);
  const bot = await created.json();
  const folderResponse = await request.post(`/api/bots/${bot.id}/folders`, {
    data: { title: '이어 쓰는 장면' },
  });
  expect(folderResponse.ok()).toBe(true);
  const chatFolder = await folderResponse.json();
  const chats = [];
  for (const [title, folderId] of [
    ['비가 그친 뒤 도서관에서 이어지는 아주 긴 대화 제목', chatFolder.id],
    ['새벽의 짧은 이야기', null],
  ]) {
    const response = await request.post('/api/chats', { data: { title, botId: bot.id, folderId } });
    expect(response.ok()).toBe(true);
    chats.push(await response.json());
  }
  const original = await (await request.get('/api/library/organization')).json();
  const response = await request.post('/api/library/folders', {
    data: {
      expectedRevision: original.revision,
      category: 'bot',
      title: '아주 긴 이름의 도시 판타지 모음',
    },
  });
  expect(response.ok()).toBe(true);
  const organization = await response.json();
  const folder = organization.folders.find(
    (item: { id: string }) => !original.folders.some((old: { id: string }) => old.id === item.id)
  );
  expect(
    (
      await request.post('/api/library/organization/move', {
        data: {
          expectedRevision: organization.revision,
          category: 'bot',
          folderId: folder.id,
          items: [{ kind: 'content', id: bot.id }],
        },
      })
    ).ok()
  ).toBe(true);
  return { bot, folder, chat: chats[0], other: chats[1] };
}

test('SIDENAV02 sidebar states keep titles steady and keyboard menus reachable without changing collapsed or docked layout', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await sidebarFixture(request);
  await page.goto(`/?chat=${fixture.chat.id}`);
  const nav = await visibleNavigation(page);
  const folder = nav.locator(`[data-bot-folder-id="${fixture.folder.id}"]`);
  const folderToggle = folder.getByRole('button', {
    name: `${fixture.folder.title} 봇 폴더`,
    exact: true,
  });
  const trigger = folder.getByLabel(`${fixture.folder.title} 봇 폴더 메뉴`, { exact: true });
  const actions = trigger.locator('..').locator('..');
  const selected = nav.locator(`[data-chat-id="${fixture.chat.id}"]`);
  const other = nav.locator(`[data-chat-id="${fixture.other.id}"]`);
  await expect(
    selected.getByRole('button', { name: fixture.chat.title, exact: true })
  ).toHaveAttribute('aria-current', 'page');
  for (const theme of ['dark', 'light']) {
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '일반');
    await page.getByLabel('앱 화면 테마', { exact: true }).selectOption(theme);
    await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
    await page.mouse.move(900, 90);
    const titleBox = await folderToggle.boundingBox();
    const selection = await selected.evaluate((node) => getComputedStyle(node).backgroundColor);
    await other.hover();
    expect(await other.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe(
      selection
    );
    await selected.hover();
    expect(await selected.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
      selection
    );
    await folderToggle.hover();
    await expect(actions).toHaveCSS('opacity', '1');
    expect(await folderToggle.boundingBox()).toEqual(titleBox);
    await page.mouse.move(900, 90);
    await expect(actions).toHaveCSS('opacity', '0');
    await folderToggle.focus();
    await page.keyboard.press('Tab');
    await expect(trigger).toBeFocused();
    await expect(actions).toHaveCSS('opacity', '1');
    await page.keyboard.press('Enter');
    const menu = folder.locator('.bot-tree-folder-heading .action-menu-body');
    await expect(menu).toBeVisible();
    await page.mouse.move(900, 90);
    await expect(actions).toHaveCSS('opacity', '1');
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(menu).toBeHidden();
    expect(await folderToggle.boundingBox()).toEqual(titleBox);
    expect(await nav.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`sidebar-polish-${theme}.png`) });
  }
  const labels = ['새 채팅', '전체 채팅 검색', '서재', '프롬프트'];
  const positions = await Promise.all(
    labels.map(
      async (name) => (await nav.getByRole('button', { name, exact: true }).boundingBox())!.y
    )
  );
  await nav.getByRole('button', { name: '좌측 패널 접기', exact: true }).click();
  await expect(page.locator('.sidebar')).toHaveCSS('width', '56px');
  for (const [index, name] of labels.entries()) {
    const box = (await nav.getByRole('button', { name, exact: true }).boundingBox())!;
    expect(Math.abs(box.y - positions[index])).toBeLessThanOrEqual(1);
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: info.outputPath('sidebar-polish-rail.png') });
  await page.reload();
  await expect(nav.getByRole('button', { name: '좌측 패널 펼치기', exact: true })).toBeVisible();
  await nav.getByRole('button', { name: '좌측 패널 펼치기', exact: true }).click();
  await expect(page.locator('.sidebar')).toHaveCSS('width', '248px');
  await expect(selected).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await openHelper(page);
  await expect(page.locator('.sidebar')).toHaveCSS('width', '56px');
  await page.getByRole('button', { name: '도우미 닫기', exact: true }).click();
  await expect(page.locator('.sidebar')).toHaveCSS('width', '248px');
});

test.describe('touch sidebar', () => {
  test.use({ hasTouch: true });
  test('SIDENAV03 folder menus stay visible and usable on phone and touch desktop', async ({
    page,
    request,
  }, info) => {
    const fixture = await sidebarFixture(request);
    for (const width of [MOBILE_WIDTH, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/?chat=${fixture.chat.id}`);
      const nav = await visibleNavigation(page);
      const folder = nav.locator(`[data-bot-folder-id="${fixture.folder.id}"]`);
      const trigger = folder.getByLabel(`${fixture.folder.title} 봇 폴더 메뉴`, { exact: true });
      const actions = trigger.locator('..').locator('..');
      await expect(actions).toHaveCSS('opacity', '1');
      const box = (await trigger.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      await trigger.tap();
      const menu = folder.locator('.bot-tree-folder-heading .action-menu-body');
      await expect(menu).toBeVisible();
      const menuBox = (await menu.boundingBox())!;
      expect(menuBox.x).toBeGreaterThanOrEqual(0);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);
      await page.screenshot({ path: info.outputPath(`sidebar-folder-menu-touch-${width}.png`) });
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      await expect(actions).toHaveCSS('opacity', '1');
      expect(await nav.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`sidebar-polish-touch-${width}.png`) });
    }
  });
});

test('SIDENAV04 desktop width choices persist and preserve the rail, mobile drawer and helper docking', async ({
  page,
  request,
}, info) => {
  const fixture = await sidebarFixture(request);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`/?chat=${fixture.chat.id}`);
  const sidebar = page.locator('.sidebar');
  await expect(sidebar).toHaveCSS('width', '248px');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '일반');
  const width = page.getByRole('combobox', { name: '좌측 사이드바 폭', exact: true });
  await expect(width).toHaveValue('248');
  await width.selectOption('400');
  await expect(sidebar).toHaveCSS('width', '400px');
  await width.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: info.outputPath('sidebar-width-settings.png') });
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await page.reload();
  await expect(sidebar).toHaveCSS('width', '400px');
  await expect(
    sidebar.getByRole('button', { name: fixture.chat.title, exact: true })
  ).toBeEnabled();
  await page.screenshot({ path: info.outputPath('sidebar-width-400-desktop.png') });

  await openHelper(page);
  await expect(page.locator('.app-shell')).toHaveClass(/panel-docked/u);
  await expect(sidebar).toHaveCSS('width', '400px');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(sidebar).toHaveCSS('width', '56px');
  await page.getByRole('button', { name: '도우미 닫기', exact: true }).click();
  await expect(sidebar).toHaveCSS('width', '400px');

  await sidebar.getByRole('button', { name: '좌측 패널 접기', exact: true }).click();
  await expect(sidebar).toHaveCSS('width', '56px');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '일반');
  await expect(width).toHaveValue('400');
  await width.selectOption('320');
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await expect(sidebar).toHaveCSS('width', '56px');
  await page.reload();
  await expect(sidebar).toHaveCSS('width', '56px');
  await sidebar.getByRole('button', { name: '좌측 패널 펼치기', exact: true }).click();
  await expect(sidebar).toHaveCSS('width', '320px');

  await page.setViewportSize({ width: MOBILE_WIDTH, height: 900 });
  await expect(sidebar).toBeHidden();
  const mobileNavigation = await visibleNavigation(page);
  await expect(mobileNavigation.getByRole('button', { name: '서재', exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath('sidebar-width-mobile-unchanged.png') });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(sidebar).toHaveCSS('width', '256px');
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(sidebar).toHaveCSS('width', '320px');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '일반');
  await expect(width).toHaveValue('320');
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await page.evaluate(() => localStorage.setItem('uimori:sidebar-width', '9999'));
  await page.reload();
  await expect(sidebar).toHaveCSS('width', '248px');
});

test('SIDENAV05 closing navigation restores the current opener after lazy library replacement', async ({
  page,
}) => {
  let releaseLibrary!: () => void;
  const libraryGate = new Promise<void>((resolve) => {
    releaseLibrary = resolve;
  });
  await page.route(/\/assets\/LibraryPanel-[^/]+\.js$/u, async (route) => {
    await libraryGate;
    await route.continue();
  });
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 900 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const opener = page.getByRole('button', { name: '탐색 메뉴', exact: true });
  await expect(page.getByRole('status')).toContainText('서재 화면을 불러오는 중');
  await opener.click();
  await expect(page.getByRole('dialog', { name: '탐색', exact: true })).toBeVisible();
  releaseLibrary();
  await expect(page.getByTestId('library-panel')).toBeAttached();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '탐색', exact: true })).toBeHidden();
  await expect(opener).toBeFocused();
  await opener.press('Enter');
  await expect(page.getByRole('dialog', { name: '탐색', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '탐색 닫기', exact: true }).click();
  await expect(opener).toBeFocused();
});
