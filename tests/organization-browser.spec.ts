import { MOBILE_WIDTH, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { visualReview } from './fixtures/visual-review.js';
import { expect, test, type APIRequestContext, type Locator } from './fixtures/browser-test.js';
import type { Content } from '../core/product.js';
import type { Chat } from '../core/types.js';
import { visibleNavigation } from './ui-navigation.js';

async function revealBotActions(scope: Locator, title?: string) {
  const heading = scope.locator('.bot-branch-heading');
  await (title ? heading.filter({ hasText: title }) : heading).first().hover();
}
async function openBotChatSearch(nav: Locator, title: string) {
  await revealBotActions(nav, title);
  await nav.getByLabel(`${title} 관리`, { exact: true }).click();
  await nav.getByRole('button', { name: '채팅 검색', exact: true }).click();
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
  const chatRow = branchA.locator(`.bot-chat-item[data-chat-id="${first.id}"]`);
  const folderHeader = branchA.getByRole('button', { name: `${folder.title} 폴더`, exact: true });
  await expect(chatRow).toHaveAttribute('draggable', 'true');
  await branchA.scrollIntoViewIfNeeded();
  await chatRow.dragTo(folderHeader, { scroll: 'none', sourcePosition: { x: 20, y: 12 } });
  await expect
    .poll(async () => (await (await request.get(`/api/chats/${first.id}`)).json()).chat.folderId)
    .toBe(folder.id);
  await expect(branchA.getByText('채팅이 없어요.', { exact: true })).toHaveCount(0);
  await nav.getByRole('button', { name: `${folder.title} 폴더`, exact: true }).hover();
  await nav.getByRole('button', { name: `${folder.title} 폴더 설정`, exact: true }).click();
  await page.getByRole('button', { name: '채팅을 유지하고 폴더 삭제', exact: true }).click();
  const confirmation = page.getByRole('alertdialog', {
    name: `‘${folder.title}’ 폴더를 삭제할까요?`,
    exact: true,
  });
  await expect(confirmation).toContainText('폴더 안의 채팅은 미분류로 옮겨져요.');
  await confirmation
    .getByRole('button', { name: '채팅을 유지하고 폴더 삭제', exact: true })
    .click();
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

{
  const width = MOBILE_WIDTH;
  test(`ORG05 ${width}px chat menu icons and manual titles preserve drafts and persist`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { chats } = await navigationFixture(request);
    const chat = chats[0];
    await page.goto(`/?chat=${chat.id}`);
    await page.getByRole('button', { name: '탐색 메뉴', exact: true }).click();
    const nav = page.getByTestId('bot-navigation').filter({ visible: true });
    const row = nav.locator(`.bot-chat-item[data-chat-id="${chat.id}"]`);
    await row.hover();
    await row.getByLabel(`${chat.title} 채팅 메뉴`, { exact: true }).click();
    const actions = row.locator('.action-menu-body');
    await actions.getByRole('button', { name: '제목 변경', exact: true }).click();
    const menu = page.getByRole('dialog', { name: '채팅 제목 변경', exact: true });
    const title = menu.getByRole('textbox', { name: '채팅 제목', exact: true });
    await title.fill('저장하지 않을 제목');
    await menu.getByRole('button', { name: '취소', exact: true }).click();
    await expect(menu).toBeHidden();
    await expect(row.getByLabel(`${chat.title} 채팅 메뉴`, { exact: true })).toBeFocused();
    expect((await (await request.get(`/api/chats/${chat.id}`)).json()).chat.title).toBe(chat.title);
    await row.hover();
    await row.getByLabel(`${chat.title} 채팅 메뉴`, { exact: true }).click();
    await actions.getByRole('button', { name: '제목 변경', exact: true }).click();
    await expect(title).toHaveValue(chat.title);
    const renamed = `직접 정한 제목 ${width}`;
    await title.fill(renamed);
    const concurrent = `다른 창 제목 ${width}`;
    const changed = await request.patch(`/api/chats/${chat.id}/title`, {
      data: { title: concurrent, expectedTitleRevision: chat.titleRevision ?? 0 },
    });
    expect(changed.ok()).toBe(true);
    const rejectedSave = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/chats/${chat.id}/title`) &&
        response.request().method() === 'PATCH'
    );
    await menu.getByRole('button', { name: '제목 저장', exact: true }).click();
    const rejected = await rejectedSave;
    expect(rejected.request().postDataJSON()).toEqual({
      title: renamed,
      expectedTitleRevision: chat.titleRevision ?? 0,
    });
    expect(rejected.status()).toBe(409);
    await expect(menu.getByRole('alert')).toBeVisible();
    await expect(title).toHaveValue(renamed);
    expect((await (await request.get(`/api/chats/${chat.id}`)).json()).chat.title).toBe(concurrent);
    await menu.getByRole('button', { name: '취소', exact: true }).click();
    await page.reload();
    await visibleNavigation(page);
    await row.hover();
    await row.getByLabel(`${concurrent} 채팅 메뉴`, { exact: true }).click();
    await actions.getByRole('button', { name: '제목 변경', exact: true }).click();
    await expect(title).toHaveValue(concurrent);
    await title.fill(renamed);
    await menu.getByRole('button', { name: '제목 저장', exact: true }).click();
    await expect
      .poll(async () => (await (await request.get(`/api/chats/${chat.id}`)).json()).chat.title)
      .toBe(renamed);
    await expect(menu).toBeHidden();
    await page.reload();
    await page.getByRole('button', { name: '탐색 메뉴', exact: true }).click();
    await expect(nav.getByRole('button', { name: renamed, exact: true })).toBeVisible();
  });
}

test('ORG02 desktop compact rows support drag ordering, folder drops, collapse and persisted order', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  const { owner, chats, folder } = await navigationFixture(request);
  await page.goto(`/?chat=${chats[0].id}`);
  const nav = page.getByTestId('bot-navigation').filter({ visible: true });
  const branch = nav.locator(`[data-bot-id="${owner.id}"]`);
  const folderHeader = branch.getByRole('button', { name: `${folder.title} 폴더`, exact: true });
  await expect(folderHeader).toBeVisible();
  const readOrder = () =>
    rows(branch).evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-chat-id'))
    );
  const order = await readOrder();
  expect(order.toSorted()).toEqual(chats.map((chat) => chat.id).toSorted());
  const moving = branch.locator(`.bot-chat-item[data-chat-id="${order[2]}"]`);
  const target = branch.locator(`.bot-chat-item[data-chat-id="${order[0]}"]`);
  await moving.dragTo(target, { targetPosition: { x: 30, y: 2 } });
  await expect.poll(readOrder).toEqual([order[2], order[0], order[1]]);
  await page.reload();
  await expect(folderHeader).toBeVisible();
  await expect.poll(readOrder).toEqual([order[2], order[0], order[1]]);
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
  await search.getByRole('searchbox', { name: '채팅 검색', exact: true }).fill(movedTitle);
  await expect(search.locator(`[data-chat-id="${order[2]}"]`)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(search).not.toBeVisible();
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

test('PIN01 chats pinned from either menu lead both sidebar tabs in pin order, survive a reload and unpin', async ({
  page,
  request,
}, info) => {
  const created = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title: `고정 실험 봇 ${Date.now()}`,
      description: 'Synthetic',
      text: 'Synthetic',
      loading: 'pinned',
      relatedIds: [],
    },
  });
  expect(created.ok()).toBe(true);
  const bot = (await created.json()) as Content;
  const chats: Chat[] = [];
  for (const title of ['첫 고정 채팅', '두 번째 고정 채팅', '고정하지 않을 채팅']) {
    const response = await request.post('/api/chats', { data: { title, botId: bot.id } });
    expect(response.ok()).toBe(true);
    chats.push((await response.json()) as Chat);
  }
  const [first, second, plain] = chats;
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto(`/?chat=${plain.id}`);
  const nav = page.getByTestId('bot-navigation').filter({ visible: true });
  const pinnedSection = nav.locator('[data-activity-section="pinned"]');
  const pinnedRows = pinnedSection.locator('[data-pinned-chat-id]');
  await expect(pinnedSection).toHaveCount(0);

  const branch = nav.locator(`[data-bot-id="${bot.id}"]`);
  const treeRow = branch.locator(`.bot-chat-item[data-chat-id="${first.id}"]`);
  await treeRow.hover();
  await treeRow.getByLabel(`${first.title} 채팅 메뉴`, { exact: true }).click();
  await treeRow.getByRole('button', { name: '상단 고정', exact: true }).click();
  await expect(pinnedRows).toHaveCount(1);
  await expect(branch.locator(`.bot-chat-item[data-chat-id="${first.id}"]`)).toHaveCount(1);

  await nav.getByRole('tab', { name: /^활동/u }).click();
  const recentRow = nav.locator(`.activity-nav-chat-row[data-chat-id="${second.id}"]`);
  await recentRow.hover();
  await recentRow.getByLabel(`${second.title} 채팅 메뉴`, { exact: true }).click();
  await recentRow.getByRole('button', { name: '상단 고정', exact: true }).click();
  await expect(pinnedRows).toHaveCount(2);
  await expect(pinnedRows.locator('strong')).toHaveText([second.title, first.title]);
  await expect(nav.locator(`.activity-nav-chat-row[data-chat-id="${second.id}"]`)).toHaveCount(1);
  if (visualReview) await page.screenshot({ path: info.outputPath('pinned-activity.png') });

  await page.reload();
  const restored = page.getByTestId('bot-navigation').filter({ visible: true });
  await restored.getByRole('tab', { name: '봇', exact: true }).click();
  const restoredRows = restored.locator('[data-activity-section="pinned"] [data-pinned-chat-id]');
  await expect(restoredRows.locator('strong')).toHaveText([second.title, first.title]);
  if (visualReview) await page.screenshot({ path: info.outputPath('pinned-bots.png') });
  await restoredRows.filter({ hasText: first.title }).locator('.activity-nav-link').click();
  await expect.poll(() => new URL(page.url()).searchParams.get('chat')).toBe(first.id);

  const pinnedSecond = restoredRows.filter({ hasText: second.title });
  await pinnedSecond.hover();
  await pinnedSecond.getByLabel(`${second.title} 채팅 메뉴`, { exact: true }).click();
  await pinnedSecond.getByRole('button', { name: '고정 해제', exact: true }).click();
  await expect(restoredRows.locator('strong')).toHaveText([first.title]);
  const remaining = restoredRows.first();
  await remaining.hover();
  await remaining.getByLabel(`${first.title} 채팅 메뉴`, { exact: true }).click();
  await remaining.getByRole('button', { name: '고정 해제', exact: true }).click();
  await expect(restored.locator('[data-activity-section="pinned"]')).toHaveCount(0);
  const listed = (await (await request.get('/api/chats')).json()) as Chat[];
  expect(listed.filter((chat) => chat.pinnedAt)).toEqual([]);
});
