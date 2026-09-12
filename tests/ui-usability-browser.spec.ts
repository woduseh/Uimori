import { MOBILE_WIDTH } from './fixtures/browser-viewports.js';
import { visualReview } from './fixtures/visual-review.js';
import { selectSettingsSection, navigationAction } from './ui-navigation.js';
import { test, expect } from '@playwright/test';
import { fixtureBotInput } from './fixtures/chat.js';

test('UXUI01 compact composer and mobile settings details preserve the draft', async ({
  page,
  request,
}, info) => {
  const created = await request.post('/api/content', {
    data: fixtureBotInput('합성 UI 검사 · 긴 이름을 가진 바닷가 도서관 안내인'),
  });
  expect(created.ok()).toBe(true);
  const bot = await created.json();
  const response = await request.post('/api/chats', {
    data: { botId: bot.id, title: '합성 화면 검사' },
  });
  expect(response.ok()).toBe(true);
  const chat = await response.json();
  expect(chat.settings.status).toBe(false);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/?chat=${chat.id}`);
  const input = page.getByLabel('다음 장면 요청', { exact: true });
  await input.fill('아직 보내지 않은 합성 요청');
  for (const width of visualReview ? [MOBILE_WIDTH, 360] : [MOBILE_WIDTH]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(input).toBeInViewport();
    await expect(page.getByRole('button', { name: /^현재 본문 모델/ })).toBeInViewport();
    await expect(page.getByRole('button', { name: '원문 생성', exact: true })).toBeInViewport();
    await expect(page.locator('.story-context')).toHaveCount(0);
    if (visualReview) {
      const dock = await page.locator('.composer-dock').boundingBox();
      expect(dock!.height).toBeLessThan(190);
    }
    await expect(page.getByRole('button', { name: '빠른 페르소나', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
    // The bundled writing prompt has controls, exposed only after opening the menu.
    await expect(page.getByRole('button', { name: '창작 옵션', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '빠른 페르소나', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(input).toHaveValue('아직 보내지 않은 합성 요청');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`compact-composer-${width}.png`) });
  }
  await navigationAction(page, '설정');
  const dialog = page.getByRole('dialog', { name: '설정', exact: true });
  const nav = dialog.locator('.settings-navigation').filter({ visible: true });
  await expect(nav).toBeVisible();
  await expect(dialog.getByLabel('앱 화면 테마')).toBeHidden();
  await selectSettingsSection(page, '데이터 관리');
  await expect(nav).toBeHidden();
  await expect(dialog.getByRole('button', { name: '설정 목록으로', exact: true })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '백업 받기', exact: true })).toBeVisible();
  await expect(dialog.getByText(/SQLite 백업은 서버를 종료하고/)).toBeHidden();
  if (visualReview) await page.screenshot({ path: info.outputPath('compact-settings-360.png') });
  const after = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(after.runs).toHaveLength(0);
  expect(after.jobs).toHaveLength(0);
  expect(errors).toEqual([]);
});
