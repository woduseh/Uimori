import { visualReview } from './fixtures/visual-review.js';
import { expect, test, type APIRequestContext, type Locator } from '@playwright/test';
import type { Content } from '../core/product.js';
import type { Chat } from '../core/types.js';
import { visibleNavigation } from './ui-navigation.js';

/** A bot row shows its actions on hover, the same way the chat rows below it do. */
async function revealBotActions(scope: Locator, title?: string) {
  const heading = scope.locator('.bot-branch-heading');
  await (title ? heading.filter({ hasText: title }) : heading).first().hover();
}
/** The bot row keeps its name; chat search now lives in that row's management menu. */
async function openBotChatSearch(nav: Locator, title: string) {
  await revealBotActions(nav, title);
  // The menu opener is the details summary, so it answers to its label rather than a button role.
  await nav.getByLabel(`${title} 관리`, { exact: true }).click();
  await nav.getByRole('button', { name: '채팅 검색', exact: true }).click();
}
/** Chat rows keep a single ⋯; rename, move and delete live inside it. */
async function openChatRowMenu(row: Locator, title: string) {
  await row.hover();
  await row.getByLabel(`${title} 채팅 메뉴`, { exact: true }).click();
}
test('ORG01 mobile navigation groups by owner and preserves chats when a folder is released', async ({
  page,
  request,
}) => {
  const suffix = Date.now();
  async function bot(title: string) {
    const response = await request.post('/api/content', {
      data: {
        kind: 'bot',
        title,
        description: 'Synthetic organization fixture',
        text: 'Synthetic bot',
        loading: 'pinned',
        relatedIds: [],
      },
    });
    expect(response.ok()).toBeTruthy();
    return response.json() as Promise<Content>;
  }
  async function chat(owner: Content, title: string) {
    const response = await request.post('/api/chats', { data: { title, botId: owner.id } });
    expect(response.ok()).toBeTruthy();
    return response.json() as Promise<Chat>;
  }
  const a = await bot(`조직 A ${suffix}`);
  const b = await bot(`조직 B ${suffix}`);
  const first = await chat(a, `A 채팅 ${suffix}`);
  await chat(b, `B 채팅 ${suffix}`);
  await page.goto(`/?chat=${first.id}`);
  await page.getByRole('button', { name: '탐색 메뉴', exact: true }).click();
  const nav = page.getByTestId('bot-navigation').filter({ visible: true });
  const branchA = nav.locator(`[data-bot-id="${a.id}"]`);
  await expect(branchA).toContainText(a.title);
  await expect(nav.getByRole('button', { name: first.title, exact: true })).toBeVisible();
  await expect(nav.getByRole('button', { name: `B 채팅 ${suffix}`, exact: true })).toHaveCount(0);
  await revealBotActions(branchA);
  await branchA.getByLabel(`${a.title} 관리`, { exact: true }).click();
  await branchA.getByRole('button', { name: '새 폴더', exact: true }).click();
  await page.getByLabel('새 폴더 이름', { exact: true }).fill(`폴더 ${suffix}`);
  await page.getByRole('button', { name: '폴더 추가', exact: true }).click();
  await expect(nav.getByRole('button', { name: `폴더 ${suffix} 폴더`, exact: true })).toBeVisible();
  await expect(branchA.getByText('채팅이 없어요.', { exact: true })).toHaveCount(1);
  const folderResponse = await request.get(`/api/bots/${a.id}/folders`);
  const [folder] = await folderResponse.json();
  await openChatRowMenu(nav.locator(`.bot-chat-item[data-chat-id="${first.id}"]`), first.title);
  await nav.getByRole('button', { name: '채팅 이동', exact: true }).click();
  await page.getByLabel(`${first.title} 폴더 이동`, { exact: true }).selectOption(folder.id);
  await expect
    .poll(async () => (await (await request.get(`/api/chats/${first.id}`)).json()).chat.folderId)
    .toBe(folder.id);
  await page.keyboard.press('Escape');
  await expect(branchA.getByText('채팅이 없어요.', { exact: true })).toHaveCount(0);
  await nav.getByRole('button', { name: `${folder.title} 폴더`, exact: true }).hover();
  await nav.getByRole('button', { name: `${folder.title} 폴더 설정`, exact: true }).click();
  await page.getByRole('button', { name: '폴더 해제 · 채팅 유지', exact: true }).click();
  await expect(nav.getByRole('button', { name: `${folder.title} 폴더`, exact: true })).toHaveCount(
    0
  );
  await expect(nav.getByRole('button', { name: first.title, exact: true })).toBeVisible();
  await expect
    .poll(async () => (await (await request.get(`/api/chats/${first.id}`)).json()).chat.folderId)
    .toBeNull();
  await nav.getByRole('button', { name: `${b.title} 채팅 목록`, exact: true }).click();
  await expect(nav.getByRole('button', { name: `B 채팅 ${suffix}`, exact: true })).toBeVisible();
  await expect(nav.getByRole('button', { name: first.title, exact: true })).toBeVisible();
  const horizontalOverflow = await nav.evaluate(
    (element) => element.scrollWidth > element.clientWidth + 1
  );
  expect(horizontalOverflow).toBe(false);
});

async function navigationFixture(request: APIRequestContext) {
  const response = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title: `탐색 합성 ${crypto.randomUUID()}`,
      description: '',
      text: 'Synthetic',
      loading: 'pinned',
      relatedIds: [],
    },
  });
  expect(response.ok()).toBe(true);
  const owner = (await response.json()) as Content;
  const chats: Chat[] = [];
  for (const title of ['첫째', '둘째', '셋째']) {
    const created = await request.post('/api/chats', { data: { title, botId: owner.id } });
    expect(created.ok()).toBe(true);
    chats.push((await created.json()) as Chat);
  }
  const created = await request.post(`/api/bots/${owner.id}/folders`, {
    data: { title: '보관 폴더' },
  });
  expect(created.ok()).toBe(true);
  return { owner, chats, folder: (await created.json()) as { id: string; title: string } };
}

const rows = (nav: Locator) => nav.locator('.bot-chat-item');

for (const width of [390, 1440]) {
  test(`ORG05 ${width}px chat menu icons and manual titles preserve drafts and persist`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const { chats } = await navigationFixture(request);
    const chat = chats[0];
    await page.goto(`/?chat=${chat.id}`);
    if (width === 390) await page.getByRole('button', { name: '탐색 메뉴', exact: true }).click();
    const nav = page.getByTestId('bot-navigation').filter({ visible: true });
    const row = nav.locator(`.bot-chat-item[data-chat-id="${chat.id}"]`);
    await row.hover();
    await row.getByLabel(`${chat.title} 채팅 메뉴`, { exact: true }).click();
    const actions = row.locator('.action-menu-body');
    await expect(actions.getByRole('button')).toHaveText(['이름 변경', '채팅 이동', '채팅 삭제']);
    await actions.getByRole('button', { name: '이름 변경', exact: true }).click();
    const menu = page.getByRole('dialog', { name: '채팅 이름 변경', exact: true });
    const title = menu.getByRole('textbox', { name: '채팅 제목', exact: true });
    await title.fill('저장하지 않을 제목');
    await menu.getByRole('button', { name: '취소', exact: true }).click();
    await expect(menu).toBeHidden();
    await expect(row.getByLabel(`${chat.title} 채팅 메뉴`, { exact: true })).toBeFocused();
    expect((await (await request.get(`/api/chats/${chat.id}`)).json()).chat.title).toBe(chat.title);
    await row.hover();
    await row.getByLabel(`${chat.title} 채팅 메뉴`, { exact: true }).click();
    await actions.getByRole('button', { name: '이름 변경', exact: true }).click();
    await expect(title).toHaveValue(chat.title);
    const renamed = `직접 정한 제목 ${width}`;
    await title.fill(renamed);
    const concurrent = `다른 창 제목 ${width}`;
    const changed = await request.patch(`/api/chats/${chat.id}/title`, {
      data: { title: concurrent, expectedTitleRevision: chat.titleRevision ?? 0 },
    });
    expect(changed.ok()).toBe(true);
    await menu.getByRole('button', { name: '제목 저장', exact: true }).click();
    await expect(menu.getByRole('alert')).toBeVisible();
    await expect(title).toHaveValue(renamed);
    expect((await (await request.get(`/api/chats/${chat.id}`)).json()).chat.title).toBe(concurrent);
    await menu.getByRole('button', { name: '취소', exact: true }).click();
    await page.reload();
    await visibleNavigation(page);
    await row.hover();
    await row.getByLabel(`${concurrent} 채팅 메뉴`, { exact: true }).click();
    await actions.getByRole('button', { name: '이름 변경', exact: true }).click();
    await expect(title).toHaveValue(concurrent);
    await title.fill(renamed);
    await menu.getByRole('button', { name: '제목 저장', exact: true }).click();
    await expect
      .poll(async () => (await (await request.get(`/api/chats/${chat.id}`)).json()).chat.title)
      .toBe(renamed);
    await expect(menu).toBeHidden();
    expect(await nav.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true
    );
    await page.screenshot({ path: info.outputPath(`chat-menu-${width}.png`) });
    await page.reload();
    if (width === 390) await page.getByRole('button', { name: '탐색 메뉴', exact: true }).click();
    await expect(nav.getByRole('button', { name: renamed, exact: true })).toBeVisible();
  });
}

test('ORG02 desktop compact rows support drag ordering, folder drops, collapse and persisted order', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { owner, chats, folder } = await navigationFixture(request);
  await page.goto(`/?chat=${chats[0].id}`);
  const nav = page.getByTestId('bot-navigation').filter({ visible: true });
  await expect(rows(nav)).toHaveCount(3);
  // Read the actual initial order so the gesture checks position independently of creation defaults.
  const order = await rows(nav).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-chat-id'))
  );
  const moving = nav.locator(`.bot-chat-item[data-chat-id="${order[2]}"]`);
  const target = nav.locator(`.bot-chat-item[data-chat-id="${order[0]}"]`);
  await page.mouse.move(1400, 950);
  const menu = moving.locator('.bot-row-actions');
  await expect(menu).toHaveCSS('opacity', '0');
  await moving.hover();
  await expect(menu).toHaveCSS('opacity', '1');
  await page.mouse.move(1400, 950);
  await moving.locator('.chat-link').focus();
  await expect(menu).toHaveCSS('opacity', '1');
  await moving.dragTo(target, { targetPosition: { x: 30, y: 2 } });
  await expect
    .poll(() =>
      rows(nav).evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-chat-id'))
      )
    )
    .toEqual([order[2], order[0], order[1]]);
  await page.reload();
  await expect
    .poll(() =>
      rows(nav).evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-chat-id'))
      )
    )
    .toEqual([order[2], order[0], order[1]]);
  const folderHeader = nav.getByRole('button', { name: `${folder.title} 폴더`, exact: true });
  const organizationWrites: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && request.url().endsWith('/organization'))
      organizationWrites.push(request.url());
  });
  await folderHeader.click();
  const sourceBox = await moving.boundingBox();
  const folderBox = await folderHeader.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(folderBox).not.toBeNull();
  await page.mouse.move(sourceBox!.x + 30, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(folderBox!.x + 40, folderBox!.y + folderBox!.height / 2, { steps: 10 });
  await expect(folderHeader).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(nav.locator('.dragging')).toHaveCount(0);
  expect(organizationWrites).toEqual([]);
  expect((await (await request.get(`/api/chats/${order[2]}`)).json()).chat.folderId).toBeNull();
  await moving.dragTo(folderHeader);
  await expect
    .poll(async () => (await (await request.get(`/api/chats/${order[2]}`)).json()).chat.folderId)
    .toBe(folder.id);
  await expect(folderHeader).toHaveAttribute('aria-expanded', 'true');
  await folderHeader.click();
  await expect(folderHeader).toHaveAttribute('aria-expanded', 'false');
  await expect(moving).toHaveCount(0);
  const movedTitle = chats.find((chat) => chat.id === order[2])!.title;
  await openBotChatSearch(nav, owner.title);
  const search = page.getByRole('dialog', { name: '이 봇의 채팅 검색', exact: true });
  await search.getByRole('textbox', { name: '채팅 검색', exact: true }).fill(movedTitle);
  await expect(search.locator(`[data-chat-id="${order[2]}"]`)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(moving).toHaveCount(0);
  await folderHeader.click();
  await page.reload();
  await expect(
    nav
      .locator('.bot-folder')
      .filter({ hasText: folder.title })
      .locator(`[data-chat-id="${order[2]}"]`)
  ).toBeVisible();
  if (visualReview) await page.screenshot({ path: info.outputPath('navigation-desktop.png') });
});

test('ORG03 touch menu offers folder movement and ordering and keeps deletion confirmation', async ({
  browser,
  request,
}, info) => {
  const { chats, folder } = await navigationFixture(request);
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  try {
    await page.goto(`/?chat=${chats[0].id}`);
    await page.getByRole('button', { name: '탐색 메뉴', exact: true }).click();
    const nav = page.getByTestId('bot-navigation').filter({ visible: true });
    await expect(rows(nav)).toHaveCount(3);
    const first = rows(nav).first();
    const firstId = await first.getAttribute('data-chat-id');
    await expect(first.locator('.bot-row-actions')).toHaveCSS('opacity', '1');
    await first.getByLabel(/채팅 메뉴$/).click();
    await first.getByRole('button', { name: '채팅 이동', exact: true }).click();
    await page.getByRole('button', { name: '아래로 이동', exact: true }).click();
    await expect.poll(() => rows(nav).nth(1).getAttribute('data-chat-id')).toBe(firstId);
    await page.keyboard.press('Escape');
    const selectedRow = nav.locator(`.bot-chat-item[data-chat-id="${chats[0].id}"]`);
    await selectedRow.getByLabel(`${chats[0].title} 채팅 메뉴`, { exact: true }).click();
    await selectedRow.getByRole('button', { name: '채팅 이동', exact: true }).click();
    await page.getByLabel(`${chats[0].title} 폴더 이동`, { exact: true }).selectOption(folder.id);
    await expect
      .poll(
        async () => (await (await request.get(`/api/chats/${chats[0].id}`)).json()).chat.folderId
      )
      .toBe(folder.id);
    await page.keyboard.press('Escape');
    await selectedRow.getByLabel(`${chats[0].title} 채팅 메뉴`, { exact: true }).click();
    await selectedRow
      .getByRole('button', { name: `${chats[0].title} 채팅 삭제`, exact: true })
      .click();
    const dialog = page.getByRole('alertdialog', { name: '삭제 확인', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect((await request.get(`/api/chats/${chats[0].id}`)).ok()).toBe(true);
    expect(await nav.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true
    );
    if (visualReview) await page.screenshot({ path: info.outputPath('navigation-touch.png') });
  } finally {
    await context.close();
  }
});

test('ORG04 unselected chat and collapsed folder display compact pending activity and clear on completion', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { chats, folder } = await navigationFixture(request);
  const background = chats[1];
  const moved = await request.patch(`/api/chats/${background.id}/organization`, {
    data: { expectedRevision: background.organizationRevision, folderId: folder.id },
  });
  expect(moved.ok()).toBe(true);
  let active = true;
  await page.route('**/api/chat-activities', (route) =>
    route.fulfill({
      json: active ? [{ chatId: background.id, kind: 'translation', count: 1 }] : [],
    })
  );
  await page.goto(`/?chat=${chats[0].id}`);
  const nav = page.getByTestId('bot-navigation').filter({ visible: true });
  const row = nav.locator(`.bot-chat-item[data-chat-id="${background.id}"]`);
  await expect(row.getByRole('img', { name: '번역 1개', exact: true })).toBeVisible();
  await row.hover();
  await expect(row.getByRole('img', { name: '번역 1개', exact: true })).toBeVisible();
  await expect(row.locator('.bot-row-actions')).toHaveCSS('opacity', '1');
  await nav.getByRole('button', { name: `${folder.title} 폴더`, exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(
    nav.getByRole('img', { name: '폴더 안에서 작업 1개 진행 중', exact: true })
  ).toBeVisible();
  if (visualReview)
    await page.screenshot({ path: info.outputPath('navigation-pending-folder.png') });
  active = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(nav.locator('.bot-chat-status')).toHaveCount(0);
});

for (const width of [390, 1440]) {
  test(`ORG06 ${width}px shared bot folders, scoped search and manual sorting persist`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const a = await navigationFixture(request);
    const b = await navigationFixture(request);
    const movedChat = await request.patch(`/api/chats/${a.chats[0].id}/organization`, {
      data: {
        expectedRevision: a.chats[0].organizationRevision,
        folderId: a.folder.id,
      },
    });
    expect(movedChat.ok()).toBe(true);
    const unused = await request.post('/api/content', {
      data: {
        kind: 'bot',
        title: `사용 전 ${crypto.randomUUID()}`,
        description: '',
        text: 'Synthetic',
        loading: 'pinned',
        relatedIds: [],
      },
    });
    expect(unused.ok()).toBe(true);
    const unusedBot = (await unused.json()) as Content;
    let organization = await (await request.get('/api/library/organization')).json();
    const folderTitle = `공유 봇 폴더 ${crypto.randomUUID()}`;
    const created = await request.post('/api/library/folders', {
      data: {
        expectedRevision: organization.revision,
        category: 'bot',
        title: folderTitle,
      },
    });
    expect(created.ok()).toBe(true);
    organization = await created.json();
    const shared = organization.folders.find(
      (folder: { title: string }) => folder.title === folderTitle
    );
    const placement = await request.post('/api/library/organization/move', {
      data: {
        expectedRevision: organization.revision,
        category: 'bot',
        folderId: shared.id,
        items: [a.owner, b.owner, unusedBot].map((bot) => ({ kind: 'content', id: bot.id })),
      },
    });
    expect(placement.ok()).toBe(true);
    // Keep this navigation assertion independent of bots created by other browser cases.
    await page.route(/\/api\/library(?:\?|$)/, async (route) => {
      const response = await route.fetch();
      const library = await response.json();
      await route.fulfill({
        response,
        json: {
          ...library,
          contents: library.contents.filter((bot: Content) =>
            [a.owner.id, b.owner.id, unusedBot.id].includes(bot.id)
          ),
        },
      });
    });
    await page.goto('/');
    let nav = await visibleNavigation(page);
    const section = nav.getByRole('button', { name: '봇', exact: true });
    await expect(section).toHaveAttribute('aria-expanded', 'false');
    await expect(nav.getByText('선택된 봇이 없어요.', { exact: true })).toHaveCount(0);
    await section.click();
    const folder = nav.locator(`[data-bot-folder-id="${shared.id}"]`);
    await folder.getByRole('button', { name: `${folderTitle} 봇 폴더`, exact: true }).click();
    const branches = folder.locator('[data-bot-id]');
    await expect(branches).toHaveCount(2);
    await expect(nav.locator(`[data-bot-id="${unusedBot.id}"]`)).toHaveCount(0);
    const branchA = nav.locator(`[data-bot-id="${a.owner.id}"]`);
    await revealBotActions(branchA);
    await branchA.getByLabel(`${a.owner.title} 관리`, { exact: true }).click();
    await branchA.getByLabel(`${a.owner.title} 봇 폴더 이동`, { exact: true }).selectOption('');
    await expect
      .poll(async () => {
        const state = await (await request.get('/api/library/organization')).json();
        return state.items.find((item: { id: string }) => item.id === a.owner.id)?.folderId;
      })
      .toBeNull();
    await expect(folder.locator(`[data-bot-id="${a.owner.id}"]`)).toHaveCount(0);
    await revealBotActions(branchA);
    await branchA.getByLabel(`${a.owner.title} 관리`, { exact: true }).click();
    await branchA
      .getByLabel(`${a.owner.title} 봇 폴더 이동`, { exact: true })
      .selectOption(shared.id);
    await expect(branches).toHaveCount(2);
    await nav.getByLabel('봇 목록 메뉴', { exact: true }).click();
    await nav.getByLabel('봇 정렬 기준', { exact: true }).selectOption('manual');
    await page.keyboard.press('Escape');
    const firstId = await branches.first().getAttribute('data-bot-id');
    const firstOwner = firstId === a.owner.id ? a.owner : b.owner;
    await revealBotActions(branches.first());
    await branches.first().getByLabel(`${firstOwner.title} 관리`, { exact: true }).click();
    await branches
      .first()
      .getByRole('button', { name: `${firstOwner.title} 아래로 이동`, exact: true })
      .click();
    const manualOrder = await branches.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-bot-id'))
    );
    expect(manualOrder[1]).toBe(firstId);
    await nav.getByLabel('봇 목록 메뉴', { exact: true }).click();
    await nav.getByLabel('봇 정렬 기준', { exact: true }).selectOption('recent');
    await expect(branches.first()).toHaveAttribute('data-bot-id', b.owner.id);
    await nav.getByLabel('봇 정렬 기준', { exact: true }).selectOption('manual');
    await page.keyboard.press('Escape');
    await page.reload();
    nav = await visibleNavigation(page);
    await expect
      .poll(() =>
        nav
          .locator(`[data-bot-folder-id="${shared.id}"] [data-bot-id]`)
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-bot-id')))
      )
      .toEqual(manualOrder);
    await openBotChatSearch(nav, a.owner.title);
    const search = page.getByRole('dialog', { name: '이 봇의 채팅 검색', exact: true });
    await search.getByRole('textbox', { name: '채팅 검색', exact: true }).fill('첫째');
    await expect(search.locator('[data-chat-id]')).toHaveCount(1);
    await expect(search.locator('[data-chat-id]')).toHaveAttribute('data-chat-id', a.chats[0].id);
    await expect(search.locator('[data-chat-id] small')).toHaveText(a.folder.title);
    await search.locator('[data-chat-id]').click();
    nav = await visibleNavigation(page);
    await expect(
      nav.locator(`[data-bot-id="${a.owner.id}"] .bot-chat-item[data-chat-id="${a.chats[0].id}"]`)
    ).toBeVisible();
    await revealBotActions(nav, a.owner.title);
    await nav.getByRole('button', { name: `${a.owner.title} 새 채팅`, exact: true }).click();
    const create = page.getByRole('dialog', { name: '새 채팅', exact: true });
    await expect(create).toBeVisible();
    await page.keyboard.press('Escape');
    nav = await visibleNavigation(page);
    expect(await nav.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true
    );
    await page.screenshot({ path: info.outputPath(`bot-tree-${width}.png`) });
  });
}

for (const width of [390, 1440]) {
  test(`ORG07 ${width}px lower sidebar bot menus stay within the viewport`, async ({
    page,
    request,
  }) => {
    const bots: Content[] = [];
    for (let index = 0; index < 10; index++) {
      const response = await request.post('/api/content', {
        data: {
          kind: 'bot',
          title: `메뉴 경계 ${index} ${crypto.randomUUID()}`,
          description: '',
          text: 'Synthetic',
          loading: 'pinned',
          relatedIds: [],
        },
      });
      expect(response.ok()).toBe(true);
      const bot = (await response.json()) as Content;
      bots.push(bot);
      expect(
        (await request.post('/api/chats', { data: { botId: bot.id, title: '경계 채팅' } })).ok()
      ).toBe(true);
    }
    await page.route(/\/api\/library(?:\?|$)/, async (route) => {
      const response = await route.fetch();
      const library = await response.json();
      await route.fulfill({
        response,
        json: {
          ...library,
          contents: library.contents.filter((bot: Content) =>
            bots.some((item) => item.id === bot.id)
          ),
        },
      });
    });
    await page.setViewportSize({ width, height: 500 });
    await page.goto('/');
    const nav = await visibleNavigation(page);
    await nav.getByRole('button', { name: '봇', exact: true }).click();
    const last = nav.locator('[data-bot-id]').last();
    await last.scrollIntoViewIfNeeded();
    const trigger = last.getByLabel(/ 관리$/);
    await revealBotActions(last);
    await trigger.click();
    const body = last.locator('.action-menu-body');
    await expect(body).toBeVisible();
    const bounds = await body.boundingBox();
    expect(bounds).not.toBeNull();
    if (!bounds) throw new Error('Bot menu has no visible bounds');
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(500);
    await page.keyboard.press('Escape');
    await expect(body).toBeHidden();
    await expect(trigger).toBeFocused();
  });
}

for (const width of [390, 1440]) {
  test(`ORG08 ${width}px first row starts a chat from the library and searches chats across bots`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const a = await navigationFixture(request);
    const b = await navigationFixture(request);
    await page.goto(`/?chat=${a.chats[0].id}`);
    await visibleNavigation(page);
    // The drawer carries the row in its header, the sidebar in its brand row; one is visible at a time.
    const search = page
      .getByRole('button', { name: '전체 채팅 검색', exact: true })
      .filter({ visible: true });
    await expect(search).toHaveCount(1);
    await search.click();
    const dialog = page.getByRole('dialog', { name: '전체 채팅 검색', exact: true });
    await dialog.getByRole('textbox', { name: '전체 채팅 검색', exact: true }).fill(b.owner.title);
    await expect(dialog.locator('[data-chat-id]')).toHaveCount(3);
    await expect(dialog.locator('[data-chat-id] small').first()).toHaveText(b.owner.title);
    await dialog.locator(`[data-chat-id="${b.chats[1].id}"]`).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(new RegExp(b.chats[1].id));
    await visibleNavigation(page);
    await page
      .getByRole('button', { name: '새 채팅', exact: true })
      .filter({ visible: true })
      .click();
    const library = page.getByTestId('library-panel');
    await expect(library).toBeVisible();
    await expect(library.getByRole('tab', { name: '봇', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });
}
