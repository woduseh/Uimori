import { expect, test } from '@playwright/test';
import type { Chat } from '../core/types.js';
import { DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { postFixtureChat } from './fixtures/chat.js';

async function createChat(request: Parameters<typeof postFixtureChat>[0], title: string) {
  const response = await postFixtureChat(request, { data: { title } });
  expect(response.ok()).toBe(true);
  return (await response.json()) as Chat;
}
const localKeys = (page: import('@playwright/test').Page) =>
  page.evaluate(() => Object.keys(localStorage).toSorted());

test('STORE02 deleting a chat removes the browser state it owned and keeps other chats', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const kept = await createChat(request, `남길 채팅 ${stamp}`);
  const target = await createChat(request, `지울 채팅 ${stamp}`);
  const owned = (chatId: string) => [
    `reading:${chatId}`,
    `uimori:activity-acknowledged:v1:${JSON.stringify(chatId)}:["main","run",1,"2026-01-01T00:00:00.000Z"]`,
    `uimori:helper-session:chat:${chatId}`,
    `uimori:helper-session-scope:${JSON.stringify({ kind: 'chat', chatId })}`,
  ];
  await page.addInitScript(
    (keys) => {
      if (sessionStorage.getItem('store02-seeded')) return;
      sessionStorage.setItem('store02-seeded', '1');
      for (const key of keys)
        localStorage.setItem(
          key,
          key.startsWith('reading:')
            ? JSON.stringify({ source: 's', anchor: 'a', offset: 0, top: 0 })
            : key.includes('activity-acknowledged')
              ? '1'
              : 'helper-conversation'
        );
    },
    [...owned(kept.id), ...owned(target.id)]
  );
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto(`/?chat=${kept.id}`);
  const nav = page.getByTestId('bot-navigation').filter({ visible: true });
  await nav.locator('.bot-navigation-modes > button').nth(1).click();
  const row = nav.locator(`.activity-nav-chat-row[data-chat-id="${target.id}"]`);
  await row.locator('.action-menu > summary').click();
  await row
    .locator('.action-menu-body')
    .getByRole('button', { name: `${target.title} 채팅 삭제`, exact: true })
    .click();
  await page
    .getByRole('alertdialog', { name: '삭제 확인', exact: true })
    .getByRole('button', { name: '영구 삭제', exact: true })
    .click();
  await expect(row).toHaveCount(0);
  await expect
    .poll(async () => {
      const keys = await localKeys(page);
      return owned(target.id).filter((key) => keys.includes(key));
    })
    .toEqual([]);
  const keys = await localKeys(page);
  for (const key of owned(kept.id).filter((key) => !key.includes('activity-acknowledged')))
    expect(keys).toContain(key);
});
