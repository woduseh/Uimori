import { test, expect, type Locator } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import {
  navigationAction,
  selectChatSettingsSection,
  selectSettingsSection,
} from './ui-navigation.js';
import { openChatSettings } from './ui-navigation.js';

async function icon(button: Locator) {
  await expect(button).toBeVisible();
  await expect(button.locator('svg')).toHaveCount(1);
  expect((await button.innerText()).trim()).toBe('');
  const label = await button.getAttribute('aria-label');
  expect(label).toBeTruthy();
  await expect(button).toHaveAccessibleName(label!);
  await expect(button).toHaveAttribute('title', label!);
  const box = await button.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}
/** Confirming actions keep the shared glyph but say what they do. The visible word is part
    of the accessible name, so speech input and the screen agree. */
async function named(button: Locator, text: string) {
  await expect(button).toBeVisible();
  await expect(button.locator('svg')).toHaveCount(1);
  expect((await button.innerText()).trim()).toBe(text);
  const label = await button.getAttribute('aria-label');
  expect(label).toContain(text);
  const box = await button.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}
for (const width of [390, 1440]) {
  test(`SICON01 ${width} settings actions stay beside their forms with compact accessible controls`, async ({
    page,
    request,
  }, info) => {
    const response = await postFixtureChat(request, {
      data: { title: `설정 아이콘 합성 ${width}` },
    });
    expect(response.ok()).toBe(true);
    const chat = await response.json();
    const workspaceResponse = await request.get('/api/prompt-workspace');
    expect(workspaceResponse.ok()).toBe(true);
    const workspace = await workspaceResponse.json();
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?chat=${chat.id}`);
    await openChatSettings(page);
    const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
    await selectChatSettingsSection(page, '봇·페르소나·모듈');
    const save = dialog.getByRole('button', { name: '채팅 설정 저장', exact: true });
    await save.scrollIntoViewIfNeeded();
    await icon(save);
    await page.screenshot({ path: info.outputPath(`chat-save-${width}.png`) });
    await selectChatSettingsSection(page, '프롬프트·창작 프리셋');
    const promptPanel = dialog.getByRole('tabpanel');
    const promptChoice = promptPanel.getByRole('combobox', {
      name: '이 채팅의 작문 프롬프트',
      exact: true,
    });
    await expect(promptChoice).toHaveValue('');
    await expect(promptChoice.locator('option:checked')).toHaveText(
      `전역 따르기 · ${workspace.main.title}`
    );
    // The select above already states whether the chat follows the global prompt, so the page
    // repeats only what it inherits and cannot change here.
    const inherited = promptPanel.locator('.settings-inherited');
    await expect(inherited.getByRole('term')).toHaveText(['번역']);
    await expect(inherited.getByRole('definition')).toHaveText([workspace.translation.title]);
    await selectChatSettingsSection(page, '자동 후속 작업');
    const runtimeSave = dialog.getByRole('button', { name: '설정 저장', exact: true });
    await icon(runtimeSave);
    await dialog.getByRole('switch', { name: '장면 상태 자동 실행' }).click();
    await expect(runtimeSave).toBeEnabled();
    await runtimeSave.click();
    await expect(dialog.getByText('후속 작업 설정을 저장했어요.', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`runtime-save-${width}.png`) });
    await selectChatSettingsSection(page, '이미지');
    await named(dialog.getByRole('button', { name: '이미지 등록', exact: true }), '등록');
    await page.screenshot({ path: info.outputPath(`image-register-${width}.png`) });
    await page.keyboard.press('Escape');
    // Both panels fetch the shared workspace. Hold it to inspect and use the loading retry.
    let ready = false;
    await page.route('**/api/prompt-workspace', async (route) => {
      if (ready) await route.continue();
      else
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: '합성 일시 오류' }),
        });
    });
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '역할별 모델');
    const settings = page.getByRole('dialog', { name: '설정', exact: true });
    const reload = settings.getByRole('button', { name: '다시 불러오기', exact: true });
    await icon(reload);
    ready = true;
    await reload.click();
    const models = settings.getByRole('region', { name: '역할별 모델 설정', exact: true });
    await expect(models).toBeVisible();
    const modelSave = models.getByRole('button', { name: '역할별 모델 설정 저장', exact: true });
    await modelSave.scrollIntoViewIfNeeded();
    await icon(modelSave);
    await expect(models).not.toContainText('새 채팅의 첫 응답이 성공하면');
    await expect(models).not.toContainText('명확한 거절일 때만 추가 번역');
    await page.screenshot({ path: info.outputPath(`model-save-${width}.png`) });
    ready = false;
    await selectSettingsSection(page, '현재 프롬프트');
    await icon(reload);
    ready = true;
    await reload.click();
    const prompts = settings.getByRole('region', { name: '현재 프롬프트 설정' });
    await expect(prompts.getByLabel('현재 프롬프트 프리셋', { exact: true })).toBeVisible();
    await expect(prompts.getByTestId('prompt-composer')).toHaveCount(0);
    await expect(prompts.getByRole('button', { name: '현재 설정 저장', exact: true })).toHaveCount(
      0
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    await page.screenshot({ path: info.outputPath(`prompt-fold-${width}.png`) });
    await page.screenshot({ path: info.outputPath(`prompt-add-${width}.png`) });
  });
}
