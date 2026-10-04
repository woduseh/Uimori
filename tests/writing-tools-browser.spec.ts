import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { postFixtureChat } from './fixtures/chat.js';
import { openChatMenu } from './ui-navigation.js';

for (const width of [1440, 412]) {
  test(`WRITINGTOOLS manuscript range download and last scene diagnostics ${width}`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const created = await postFixtureChat(request, {
      data: { title: `Writing tools ${randomUUID()}` },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const empty = await created.json();
    const transcript = await (await request.get(`/api/chats/${empty.id}/transcript`)).json();
    transcript.entries = [
      {
        request: 'PRIVATE REQUEST ONE',
        text: 'First scene.\n\nOriginal paragraphs.',
        translation: '첫 장면.\n\n원래 문단.',
      },
      { request: 'PRIVATE REQUEST TWO', text: 'Second scene.', translation: null },
    ];
    const imported = await request.post('/api/chats/import-transcript', {
      data: { transcript, idempotencyKey: randomUUID() },
    });
    expect(imported.ok(), await imported.text()).toBe(true);
    const { chat } = await imported.json();
    await page.goto(`/?chat=${chat.id}`);
    const composer = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
    await composer.fill('이 요청 초안은 그대로 남겨요.');
    await expect(page.getByTestId('scene-usage').last()).toContainText('요청 미확인');
    await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
    await page.getByRole('button', { name: '마지막 장면의 로어', exact: true }).click();
    const lore = page.getByRole('dialog', { name: '마지막 장면의 로어', exact: true });
    await expect(lore).toBeVisible();
    await expect(lore).toContainText('로어를 보내지 않았다는 뜻은 아니에요.');
    await page.screenshot({ path: info.outputPath(`last-scene-lore-${width}.png`) });
    await lore.getByRole('button', { name: '마지막 장면의 로어 닫기', exact: true }).click();
    await expect(composer).toHaveValue('이 요청 초안은 그대로 남겨요.');
    await expect(page.getByRole('button', { name: '입력창 더보기', exact: true })).toBeFocused();
    await openChatMenu(page);
    await page.getByRole('button', { name: '원고 내보내기', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '원고 내보내기', exact: true });
    await expect(dialog).toHaveAccessibleName('원고 내보내기');
    await dialog
      .getByRole('combobox', { name: '내보낼 본문', exact: true })
      .selectOption('translation');
    await dialog.getByRole('button', { name: 'Markdown 다운로드', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('2');
    await dialog.getByRole('combobox', { name: '장면 범위', exact: true }).selectOption('range');
    await dialog.getByRole('combobox', { name: '끝 장면', exact: true }).selectOption('1');
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`manuscript-export-${width}.png`) });
    const nextDownload = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Markdown 다운로드', exact: true }).click();
    const download = await nextDownload;
    expect(download.suggestedFilename()).toMatch(/\.md$/);
    expect(await readFile((await download.path())!, 'utf8')).toBe('첫 장면.\n\n원래 문단.\n');
    await expect(dialog).toBeHidden();
    await expect(composer).toHaveValue('이 요청 초안은 그대로 남겨요.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
  });
}
