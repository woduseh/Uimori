import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Bookmark } from '../core/reading-state.js';
import { MOBILE_WIDTH } from './fixtures/browser-viewports.js';
import { createReadingChat } from './fixtures/personal-workspace.js';

test.setTimeout(60000);

async function openBookmarks(page: Page, chatId: string) {
  await page.goto(`/?chat=${chatId}`);
  await expect(page.locator('[data-testid="source"]').first()).toBeVisible();
  await page
    .getByRole('button', { name: '장면 목록 열기', exact: true })
    .filter({ visible: true })
    .first()
    .click();
  const navigator = page.getByRole('dialog', { name: '장면 목록', exact: true });
  await navigator
    .locator('summary')
    .filter({ hasText: /^책갈피$/ })
    .click();
  const list = navigator.getByRole('region', { name: '이 채팅의 책갈피', exact: true });
  await expect(list.getByRole('status')).toHaveCount(0);
  return { navigator, list };
}

async function seedBookmark(request: APIRequestContext, width: number) {
  const { chat } = await createReadingChat(request, `책갈피 확인 ${width} ${Date.now()}`, 1);
  const detail = await (await request.get(`/api/chats/${chat.id}`)).json();
  const response = await request.post(`/api/chats/${chat.id}/bookmarks`, {
    data: {
      id: crypto.randomUUID(),
      title: '검토할 책갈피',
      note: '저장된 메모',
      quote: 'Scene 1.',
      target: { chatId: chat.id, sourceId: detail.sources[0].id, representation: 'original' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return { chat, bookmark: (await response.json()) as Bookmark };
}

async function savedBookmarks(request: APIRequestContext, chatId: string) {
  return (await (await request.get(`/api/chats/${chatId}/bookmarks`)).json()) as Bookmark[];
}

function nativeDialogs(page: Page) {
  const messages: string[] = [];
  page.on('dialog', async (dialog) => {
    messages.push(dialog.message());
    await dialog.dismiss();
  });
  return messages;
}

const width = MOBILE_WIDTH;
test(`BMCONF01 bookmark discard cancellation, Escape, backdrop and save preserve data and focus at ${width}`, async ({
  page,
  request,
}) => {
  const { chat, bookmark } = await seedBookmark(request, width);
  const native = nativeDialogs(page);
  await page.setViewportSize({ width, height: 900 });
  const { navigator, list } = await openBookmarks(page, chat.id);
  const opener = list.getByRole('button', { name: `${bookmark.title} 책갈피 편집`, exact: true });
  const editor = page.locator('dialog.bookmark-dialog');
  const close = editor.getByRole('button', { name: '책갈피 편집 닫기', exact: true });
  const confirmation = page.getByRole('alertdialog', { name: '미저장 책갈피 확인', exact: true });
  await opener.click();
  await editor.getByLabel('책갈피 이름').fill('저장하지 않은 이름');
  await editor.getByLabel('책갈피 메모').fill('취소해도 남아야 하는 메모');
  await close.click();
  await expect(confirmation.getByRole('button', { name: '계속 편집', exact: true })).toBeFocused();
  await confirmation.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(close).toBeFocused();
  await expect(editor.getByLabel('책갈피 이름')).toHaveValue('저장하지 않은 이름');
  await page.keyboard.press('Escape');
  await expect(confirmation).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirmation).not.toBeVisible();
  await expect(editor).toBeVisible();
  await expect(navigator).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(confirmation).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(confirmation).not.toBeVisible();
  await expect(editor.getByLabel('책갈피 메모')).toHaveValue('취소해도 남아야 하는 메모');
  expect(await savedBookmarks(request, chat.id)).toEqual([bookmark]);
  await close.click();
  await confirmation.getByRole('button', { name: '초안 버리고 닫기', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(navigator).toBeVisible();
  await expect(opener).toBeFocused();
  expect(await savedBookmarks(request, chat.id)).toEqual([bookmark]);

  await opener.click();
  await editor.getByLabel('책갈피 이름').fill('직접 저장한 이름');
  await editor.getByRole('button', { name: '책갈피 변경 저장', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(list.getByRole('button', { name: '직접 저장한 이름', exact: true })).toBeVisible();
  const savedOpener = list.getByRole('button', {
    name: '직접 저장한 이름 책갈피 편집',
    exact: true,
  });
  await savedOpener.click();
  await editor.getByLabel('책갈피 메모').fill('닫을 때 저장한 메모');
  await close.click();
  await confirmation.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(confirmation).toHaveCount(0);
  await expect(savedOpener).toBeFocused();
  expect(await savedBookmarks(request, chat.id)).toMatchObject([
    {
      id: bookmark.id,
      revision: bookmark.revision + 2,
      title: '직접 저장한 이름',
      note: '닫을 때 저장한 메모',
    },
  ]);
  expect(native).toEqual([]);
});

test(`BMCONF03 bookmark deletion cancellation, stale revision and busy guard preserve the manuscript at ${width}`, async ({
  page,
  request,
}) => {
  const { chat, bookmark } = await seedBookmark(request, width);
  const native = nativeDialogs(page);
  const before = await (await request.get(`/api/chats/${chat.id}/transcript`)).json();
  await page.setViewportSize({ width, height: 900 });
  const { navigator, list } = await openBookmarks(page, chat.id);
  const refresh = list.getByRole('button', { name: '책갈피 다시 불러오기', exact: true });
  await expect(refresh).toHaveCount(0);
  const opener = list.getByRole('button', { name: `${bookmark.title} 책갈피 삭제`, exact: true });
  const confirmation = page.getByRole('alertdialog', { name: '삭제 확인', exact: true });
  await opener.click();
  await expect(confirmation).toContainText(`${bookmark.title} 책갈피 항목을 삭제할까요?`);
  await confirmation.getByRole('button', { name: '취소', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(opener).toBeFocused();
  await opener.click();
  await page.keyboard.press('Escape');
  await expect(confirmation).not.toBeVisible();
  await expect(navigator).toBeVisible();
  await expect(opener).toBeFocused();
  await opener.click();
  await page.mouse.click(5, 5);
  await expect(confirmation).not.toBeVisible();
  await expect(opener).toBeFocused();
  expect(await savedBookmarks(request, chat.id)).toEqual([bookmark]);

  await opener.click();
  const changed = await request.patch(`/api/bookmarks/${bookmark.id}`, {
    data: {
      expectedRevision: bookmark.revision,
      title: '다른 기기에서 수정한 책갈피',
      note: bookmark.note,
    },
  });
  expect(changed.ok()).toBe(true);
  const latest = (await changed.json()) as Bookmark;
  await confirmation.getByRole('button', { name: '삭제', exact: true }).click();
  await expect(confirmation.getByRole('alert')).toContainText('책갈피가 변경됐어요');
  expect(await savedBookmarks(request, chat.id)).toEqual([latest]);
  await confirmation.getByRole('button', { name: '취소', exact: true }).click();
  await expect(refresh).toBeVisible();
  await refresh.click();
  await expect(list.getByRole('button', { name: latest.title, exact: true })).toBeVisible();
  await expect(refresh).toHaveCount(0);
  await list.getByRole('button', { name: `${latest.title} 책갈피 삭제`, exact: true }).click();

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deletions: unknown[] = [];
  const path = `/api/bookmarks/${bookmark.id}`;
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    deletions.push(route.request().postDataJSON());
    await held;
    await route.continue();
  });
  try {
    await confirmation.getByRole('button', { name: '삭제', exact: true }).click();
    await expect.poll(() => deletions.length).toBe(1);
    await expect(confirmation.getByRole('button', { name: '취소', exact: true })).toBeDisabled();
    await expect(
      confirmation.getByRole('button', { name: '삭제 중…', exact: true })
    ).toBeDisabled();
    await confirmation.getByRole('button', { name: '삭제 확인 닫기', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 5);
    await expect(confirmation).toBeVisible();
    expect(await savedBookmarks(request, chat.id)).toEqual([latest]);
    expect(deletions).toEqual([{ expectedRevision: latest.revision }]);
    release();
    await expect(confirmation).not.toBeVisible();
    await expect(list).toContainText('아직 책갈피가 없어요');
    await expect(navigator).toBeVisible();
    expect(await savedBookmarks(request, chat.id)).toEqual([]);
    expect(deletions).toHaveLength(1);
    const after = await (await request.get(`/api/chats/${chat.id}/transcript`)).json();
    expect(after.entries).toEqual(before.entries);
  } finally {
    release();
    await page.unroute(`**${path}`);
  }
  expect(native).toEqual([]);
});
