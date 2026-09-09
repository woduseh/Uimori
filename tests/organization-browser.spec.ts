import { visualReview } from './fixtures/visual-review.js';
import { expect, test, type APIRequestContext, type Locator } from '@playwright/test';
import type { Content } from '../core/product.js';
import type { Chat } from '../core/types.js';

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
  await expect(nav.locator('.bot-switch-button')).toContainText(a.title);
  await expect(nav.getByRole('button', { name: first.title, exact: true })).toBeVisible();
  await expect(nav.getByRole('button', { name: `B 채팅 ${suffix}`, exact: true })).toHaveCount(0);
  await nav.getByRole('button', { name: '봇 목록', exact: true }).click();
  await nav.getByRole('button', { name: '새 폴더', exact: true }).click();
  await page.getByLabel('새 폴더 이름', { exact: true }).fill(`폴더 ${suffix}`);
  await page.getByRole('button', { name: '폴더 추가', exact: true }).click();
  await expect(nav.getByRole('button', { name: `폴더 ${suffix} 폴더`, exact: true })).toBeVisible();
  const folderResponse = await request.get(`/api/bots/${a.id}/folders`);
  const [folder] = await folderResponse.json();
  await nav.locator(`[data-chat-id="${first.id}"]`).hover();
  await nav.getByRole('button', { name: `${first.title} 채팅 메뉴`, exact: true }).click();
  await page.getByLabel(`${first.title} 폴더 이동`, { exact: true }).selectOption(folder.id);
  await expect
    .poll(async () => (await (await request.get(`/api/chats/${first.id}`)).json()).chat.folderId)
    .toBe(folder.id);
  await page.keyboard.press('Escape');
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
  await nav.getByRole('button', { name: '봇 목록', exact: true }).click();
  await nav.getByRole('button').filter({ hasText: b.title }).click();
  await expect(nav.getByRole('button', { name: `B 채팅 ${suffix}`, exact: true })).toBeVisible();
  await expect(nav.getByRole('button', { name: first.title, exact: true })).toHaveCount(0);
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
    const { chats, folder } = await navigationFixture(request);
    const chat = chats[0];
    await page.goto(`/?chat=${chat.id}`);
    if (width === 390) await page.getByRole('button', { name: '탐색 메뉴', exact: true }).click();
    const nav = page.getByTestId('bot-navigation').filter({ visible: true });
    const row = nav.locator(`[data-chat-id="${chat.id}"]`);
    await row.hover();
    await row.getByRole('button', { name: /채팅 메뉴$/ }).click();
    const menu = page.getByRole('dialog', { name: '채팅 메뉴', exact: true });
    for (const label of ['위로 이동', '아래로 이동']) {
      const button = menu.getByRole('button', { name: label, exact: true });
      await expect(button).toHaveText('');
      await expect(button).toHaveAttribute('title', label);
    }
    const deletion = menu.getByRole('button', { name: `${chat.title} 채팅 삭제`, exact: true });
    await expect(deletion).toHaveText('');
    await expect(deletion).toHaveAttribute('title', '채팅 삭제');
    const actions = menu.locator('.bot-chat-menu-actions');
    expect(
      await actions.evaluate((element) => {
        const buttons = [...element.querySelectorAll('button')].filter((button) =>
          button.checkVisibility()
        );
        const boxes = buttons.map((button) => button.getBoundingClientRect());
        return (
          boxes.length === 3 &&
          boxes.every(
            (box) => Math.abs(box.top - boxes[0].top) < 2 && box.width >= 44 && box.height >= 44
          )
        );
      })
    ).toBe(true);
    const title = menu.getByRole('textbox', { name: '채팅 제목', exact: true });
    await title.fill('저장하지 않을 제목');
    await menu.getByRole('button', { name: '취소', exact: true }).click();
    await expect(title).toHaveValue(chat.title);
    const renamed = `직접 정한 제목 ${width}`;
    await title.fill(renamed);
    // Organization refreshes the Chat object without discarding a title draft.
    await menu.getByLabel(`${chat.title} 폴더 이동`, { exact: true }).selectOption(folder.id);
    await expect
      .poll(async () => (await (await request.get(`/api/chats/${chat.id}`)).json()).chat.folderId)
      .toBe(folder.id);
    await expect(title).toHaveValue(renamed);
    await menu.getByRole('button', { name: '제목 저장', exact: true }).click();
    await expect
      .poll(async () => (await (await request.get(`/api/chats/${chat.id}`)).json()).chat.title)
      .toBe(renamed);
    await expect(menu.getByRole('button', { name: '제목 저장', exact: true })).toHaveCount(0);
    expect(await menu.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true
    );
    if (visualReview) await page.screenshot({ path: info.outputPath(`chat-menu-${width}.png`) });
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
  const { chats, folder } = await navigationFixture(request);
  await page.goto(`/?chat=${chats[0].id}`);
  const nav = page.getByTestId('bot-navigation').filter({ visible: true });
  await expect(rows(nav)).toHaveCount(3);
  // Read the actual initial order so the gesture checks position independently of creation defaults.
  const order = await rows(nav).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-chat-id'))
  );
  const moving = nav.locator(`[data-chat-id="${order[2]}"]`);
  const target = nav.locator(`[data-chat-id="${order[0]}"]`);
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
  await nav.getByLabel('채팅 검색', { exact: true }).fill('째');
  await moving.dragTo(target, { targetPosition: { x: 30, y: 28 } });
  await nav.getByLabel('채팅 검색', { exact: true }).fill('');
  expect(organizationWrites).toEqual([]);
  await expect
    .poll(() =>
      rows(nav).evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-chat-id'))
      )
    )
    .toEqual([order[2], order[0], order[1]]);
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
  await nav.getByLabel('채팅 검색', { exact: true }).fill(movedTitle);
  await expect(moving).toBeVisible();
  await nav.getByLabel('채팅 검색', { exact: true }).fill('');
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
    await first.getByRole('button', { name: /채팅 메뉴$/ }).click();
    await page.getByRole('button', { name: '아래로 이동', exact: true }).click();
    await expect.poll(() => rows(nav).nth(1).getAttribute('data-chat-id')).toBe(firstId);
    await page.keyboard.press('Escape');
    const selectedRow = nav.locator(`[data-chat-id="${chats[0].id}"]`);
    await selectedRow.getByRole('button', { name: /채팅 메뉴$/ }).click();
    await page.getByLabel(`${chats[0].title} 폴더 이동`, { exact: true }).selectOption(folder.id);
    await expect
      .poll(
        async () => (await (await request.get(`/api/chats/${chats[0].id}`)).json()).chat.folderId
      )
      .toBe(folder.id);
    await page
      .getByRole('dialog', { name: '채팅 메뉴', exact: true })
      .getByRole('button', { name: `${chats[0].title} 채팅 삭제`, exact: true })
      .click();
    const dialog = page.getByRole('alertdialog', { name: '삭제 확인', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await page.keyboard.press('Escape');
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
  const row = nav.locator(`[data-chat-id="${background.id}"]`);
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
