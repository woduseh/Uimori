import { reviewWidths, visualReview } from './fixtures/visual-review.js';
import { test, expect } from '@playwright/test';
import { fixtureBotInput } from './fixtures/chat.js';
import {
  navigationAction,
  selectSettingsSection,
  startProviderConnection,
} from './ui-navigation.js';

test('SCUI03 multi-entry browser back keeps the address and chat consistent with clean and dirty settings', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const created = await request.post('/api/content', {
    data: fixtureBotInput('설정 이력 검사 합성 봇'),
  });
  expect(created.ok()).toBe(true);
  const bot = await created.json();
  const chats = [];
  for (const title of ['설정 이력 첫 채팅', '설정 이력 두번째 채팅']) {
    const response = await request.post('/api/chats', { data: { botId: bot.id, title } });
    expect(response.ok()).toBe(true);
    chats.push(await response.json());
  }
  await page.goto(`/?chat=${chats[0].id}`);
  const next = page.locator('.sidebar').getByRole('button', { name: chats[1].title, exact: true });
  await next.click();
  await expect(page).toHaveURL(new RegExp(`chat=${chats[1].id}`));
  const composer = page.getByLabel('다음 장면 요청', { exact: true });
  await composer.fill('두번째 채팅의 미전송 요청');
  await navigationAction(page, '설정');
  const dialog = page.getByRole('dialog', { name: '설정', exact: true });
  await expect(dialog.locator('.settings-navigation')).toBeVisible();
  await page.evaluate(() => history.go(-2));
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`chat=${chats[0].id}`));
  await expect(page.locator('.header-title h1')).toHaveText(chats[0].title);
  await next.click();
  await expect(composer).toHaveValue('두번째 채팅의 미전송 요청');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '연결과 모델');
  await startProviderConnection(page);
  await page.getByRole('button', { name: /OpenAI · Responses/ }).click();
  const name = page
    .getByRole('form', { name: '연결 편집 양식' })
    .getByLabel('연결 이름', { exact: true });
  await name.fill('이력을 건너뛰어도 보존할 초안');
  await page.evaluate(() => history.go(-2));
  const confirm = page.getByRole('alertdialog', { name: '미저장 설정 확인', exact: true });
  await expect(confirm).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`chat=${chats[1].id}`));
  await confirm.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expect(name).toHaveValue('이력을 건너뛰어도 보존할 초안');
  await dialog.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await confirm.getByRole('button', { name: '초안 버리고 닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`chat=${chats[1].id}`));
  await expect(page.locator('.header-title h1')).toHaveText(chats[1].title);
  await expect(composer).toHaveValue('두번째 채팅의 미전송 요청');
});

test('SCUI01 settings list and details adapt at six widths with distinct icons and no overflow', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await navigationAction(page, '설정');
  const dialog = page.getByRole('dialog', { name: '설정', exact: true });
  const nav = dialog.locator('.settings-navigation');
  await expect(nav.getByRole('button')).toHaveCount(5);
  await expect(dialog.getByRole('tabpanel')).toHaveCount(0);
  if (visualReview) {
    const icons = await nav
      .locator('svg')
      .evaluateAll((nodes) => nodes.map((node) => node.innerHTML));
    expect(new Set(icons).size).toBe(5);
  }
  if (visualReview) await page.screenshot({ path: info.outputPath('settings-list-390.png') });
  await selectSettingsSection(page, '일반');
  for (const width of reviewWidths([360, 390, 430, 768, 1024, 1440])) {
    await page.setViewportSize({ width, height: 900 });
    await expect(dialog.getByLabel('앱 화면 테마')).toBeVisible();
    await expect(dialog.getByRole('tabpanel')).toHaveCount(1);
    if (width <= 760) {
      await expect(nav).toBeHidden();
      await expect(dialog.getByRole('heading', { name: '일반', exact: true })).toHaveCount(1);
      const back = dialog.getByRole('button', { name: '설정 목록으로', exact: true });
      const bounds = await back.boundingBox();
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
    } else {
      await expect(nav).toBeVisible();
      await expect(nav.getByRole('tab')).toHaveCount(5);
    }
    expect(
      await dialog.evaluate((node) => node.scrollWidth - node.clientWidth)
    ).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    if (width === 390 || width === 1440)
      if (visualReview)
        await page.screenshot({ path: info.outputPath(`settings-general-${width}.png`) });
  }
  await nav.getByRole('tab', { name: '일반', exact: true }).focus();
  await page.keyboard.press('End');
  await expect(nav.getByRole('tab', { name: '접근 보안', exact: true })).toBeFocused();
  await expect(dialog.getByRole('button', { name: '접속 해제', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  const opener = page
    .getByTestId('bot-navigation')
    .filter({ visible: true })
    .getByRole('button', { name: '설정', exact: true });
  await opener.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  expect(errors).toEqual([]);
});

test('SCUI02 settings back, resize and close preserve provider and chat drafts until explicit discard', async ({
  page,
  request,
}, info) => {
  const created = await request.post('/api/content', {
    data: fixtureBotInput('설정 초안 보존 합성 봇'),
  });
  expect(created.ok()).toBe(true);
  const bot = await created.json();
  const response = await request.post('/api/chats', {
    data: { botId: bot.id, title: '설정 초안 보존 합성 채팅' },
  });
  expect(response.ok()).toBe(true);
  const chat = await response.json();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?chat=${chat.id}`);
  const composer = page.getByLabel('다음 장면 요청', { exact: true });
  await composer.fill('계속 보존할 사용자 요청');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '연결과 모델');
  await startProviderConnection(page);
  await page.getByRole('button', { name: /OpenAI · Responses/ }).click();
  const name = page
    .getByRole('form', { name: '연결 편집 양식' })
    .getByLabel('연결 이름', { exact: true });
  await name.fill('아직 저장하지 않은 합성 연결');
  await page.goBack();
  const dialog = page.getByRole('dialog', { name: '설정', exact: true });
  await expect(dialog.locator('.settings-navigation')).toBeVisible();
  await expect(dialog.getByRole('tabpanel')).toHaveCount(0);
  await page.goBack();
  const confirm = page.getByRole('alertdialog', { name: '미저장 설정 확인', exact: true });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '계속 편집', exact: true }).click();
  await selectSettingsSection(page, '연결과 모델');
  await expect(name).toHaveValue('아직 저장하지 않은 합성 연결');
  await name.focus();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(name).toBeFocused();
  await selectSettingsSection(page, '일반');
  await selectSettingsSection(page, '연결과 모델');
  await expect(name).toHaveValue('아직 저장하지 않은 합성 연결');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(name).toBeVisible();
  await dialog.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await expect(confirm).toBeVisible();
  if (visualReview) await page.screenshot({ path: info.outputPath('settings-unsaved-390.png') });
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(name).toHaveValue('아직 저장하지 않은 합성 연결');
  await dialog.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await confirm.getByRole('button', { name: '초안 버리고 닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(composer).toHaveValue('계속 보존할 사용자 요청');
  await expect(page).toHaveURL(new RegExp(`chat=${chat.id}`));
  const after = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(after.runs).toHaveLength(0);
  expect(after.jobs).toHaveLength(0);
});
