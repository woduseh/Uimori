import { expect, test } from '@playwright/test';
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
  await expect(nav.getByRole('heading', { name: a.title, exact: true })).toBeVisible();
  await expect(nav.getByRole('button', { name: first.title, exact: true })).toBeVisible();
  await expect(nav.getByRole('button', { name: `B 채팅 ${suffix}`, exact: true })).toHaveCount(0);
  await nav.getByText('폴더 만들기', { exact: true }).click();
  await nav.getByLabel('새 폴더 이름', { exact: true }).fill(`폴더 ${suffix}`);
  await nav.getByRole('button', { name: '폴더 추가', exact: true }).click();
  await expect(nav.getByRole('heading', { name: `폴더 ${suffix}`, exact: true })).toBeVisible();
  const folderResponse = await request.get(`/api/bots/${a.id}/folders`);
  const [folder] = await folderResponse.json();
  await nav.getByLabel(`${first.title} 폴더 이동`, { exact: true }).selectOption(folder.id);
  await expect
    .poll(async () => (await (await request.get(`/api/chats/${first.id}`)).json()).chat.folderId)
    .toBe(folder.id);
  await nav.getByText(`${folder.title} 폴더 설정`, { exact: true }).click();
  await nav.getByRole('button', { name: '폴더 해제 · 채팅 유지', exact: true }).click();
  await expect(nav.getByRole('heading', { name: folder.title, exact: true })).toHaveCount(0);
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
