import { expect, test } from '@playwright/test';
import { DESKTOP_HEIGHT, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { createReadingChat } from './fixtures/personal-workspace.js';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
  await page.addInitScript(() => localStorage.setItem('uimori:reading-language', 'original'));
});

test('SHORTCUT01 default bindings move between the sidebar, helper, settings and search', async ({
  page,
  request,
}) => {
  const { chat } = await createReadingChat(request, `단축키 이동 ${Date.now()}`, 1);
  await page.goto(`/?chat=${chat.id}`);
  const shell = page.locator('.app-shell');
  const composer = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
  await composer.click();

  await expect(shell).not.toHaveClass(/sidebar-collapsed/);
  await page.keyboard.press('Control+B');
  await expect(shell).toHaveClass(/sidebar-collapsed/);
  await page.keyboard.press('Control+B');
  await expect(shell).not.toHaveClass(/sidebar-collapsed/);

  const helper = page.locator('#helper-panel');
  await page.keyboard.press('Control+Backslash');
  await expect(helper).toBeVisible();
  await composer.click();
  await page.keyboard.press('Control+Backslash');
  await expect(helper).toBeHidden();

  await composer.click();
  await page.keyboard.press('Control+Comma');
  const settings = page.getByRole('dialog', { name: '설정', exact: true });
  await expect(settings).toBeVisible();
  await page.keyboard.press('Control+B');
  await expect(shell).not.toHaveClass(/sidebar-collapsed/);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  await composer.click();
  await page.keyboard.press('Control+F');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+F');
  const search = page.getByRole('dialog', { name: '전체 채팅 검색', exact: true });
  await expect(search).toBeVisible();
  await expect(search.getByRole('searchbox', { name: '전체 채팅 검색', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(search).toBeHidden();
});

test('SHORTCUT02 typing and Korean composition in the composer and editors stay untouched', async ({
  page,
  request,
}) => {
  const { chat } = await createReadingChat(request, `단축키 입력 ${Date.now()}`, 1);
  await page.goto(`/?chat=${chat.id}`);
  const composer = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
  await composer.fill('한글 조합');
  for (const code of ['KeyK', 'KeyB', 'Backslash', 'Comma', 'KeyS', 'Period'])
    await composer.dispatchEvent('keydown', {
      key: code,
      code,
      ctrlKey: true,
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
  await page.keyboard.type(' 중 kbs,');
  await expect(composer).toHaveValue('한글 조합 중 kbs,');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.app-shell')).not.toHaveClass(/sidebar-collapsed/);
  await expect(page.locator('#helper-panel')).toBeHidden();

  const scene = page.getByTestId('source');
  await scene.getByRole('button', { name: '원문 수정', exact: true }).click();
  const editor = scene.locator('.source-text-editor textarea');
  await expect(editor).toBeFocused();
  await editor.press('Control+End');
  await page.keyboard.type(' 끝');
  await editor.dispatchEvent('keydown', {
    key: 's',
    code: 'KeyS',
    ctrlKey: true,
    isComposing: true,
    bubbles: true,
    cancelable: true,
  });
  await expect(editor).toHaveValue(/ 끝$/);
  await expect(editor).toBeVisible();
});

test('SHORTCUT03 Ctrl+S saves the focused source editor and nothing else', async ({
  page,
  request,
}) => {
  const { chat, detail } = await createReadingChat(request, `단축키 저장 ${Date.now()}`, 1);
  await page.goto(`/?chat=${chat.id}`);
  const saves: string[] = [];
  page.on('request', (event) => {
    if (event.method() === 'PUT') saves.push(new URL(event.url()).pathname);
  });
  const composer = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
  await composer.click();
  await page.keyboard.press('Control+S');
  await expect(composer).toBeFocused();

  const scene = page.getByTestId('source');
  await scene.getByRole('button', { name: '원문 수정', exact: true }).click();
  const editor = scene.locator('.source-text-editor textarea');
  await editor.fill('단축키로 저장한 원문.');
  await page.keyboard.press('Control+S');
  await expect(editor).toHaveCount(0);
  await expect(scene).toContainText('단축키로 저장한 원문.');
  expect(saves).toEqual([`/api/sources/${detail.sources[0].id}/text`]);
  const saved = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(saved.sources[0].text).toBe('단축키로 저장한 원문.');
});
