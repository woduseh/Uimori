import { test, expect, type APIRequestContext, type Page } from './fixtures/browser-test.js';
import type { Bookmark } from '../core/reading-state.js';
import type { ChatDetail } from '../core/types.js';
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

const width = MOBILE_WIDTH;
test(`BMCONF03 bookmark deletion cancellation and stale revision preserve the manuscript at ${width}`, async ({
  page,
  request,
}) => {
  const { chat, bookmark } = await seedBookmark(request, width);
  const manuscript = async () =>
    ((await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail).sources;
  const before = await manuscript();
  await page.setViewportSize({ width, height: 900 });
  const { list } = await openBookmarks(page, chat.id);
  const refresh = list.getByRole('button', { name: '책갈피 다시 불러오기', exact: true });
  const opener = list.getByRole('button', { name: `${bookmark.title} 책갈피 삭제`, exact: true });
  const confirmation = page.getByRole('alertdialog', { name: '삭제 확인', exact: true });
  await opener.click();
  await confirmation.getByRole('button', { name: '취소', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
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
  await expect(confirmation.getByRole('alert')).toBeVisible();
  expect(await savedBookmarks(request, chat.id)).toEqual([latest]);
  await confirmation.getByRole('button', { name: '취소', exact: true }).click();
  await refresh.click();
  await list.getByRole('button', { name: `${latest.title} 책갈피 삭제`, exact: true }).click();
  await confirmation.getByRole('button', { name: '삭제', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(list.getByRole('button', { name: latest.title, exact: true })).toHaveCount(0);
  expect(await savedBookmarks(request, chat.id)).toEqual([]);
  expect(await manuscript()).toEqual(before);
});
