import { test, expect } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import { openChatSettings } from './ui-navigation.js';

for (const width of [1440, 412]) {
  test(`TOOLTIP ${width} native icon hints preserve dialog interaction`, async ({
    page,
    request,
  }, info) => {
    const height = width === 412 ? 844 : 1000;
    const mode = width === 412 ? 'light' : 'dark';
    await page.setViewportSize({ width, height });
    await page.addInitScript((theme) => localStorage.setItem('uimori:theme', theme), mode);
    const response = await postFixtureChat(request, { data: { title: '툴팁 검증용 서재' } });
    expect(response.ok()).toBe(true);
    const chat = await response.json();
    await page.goto(`/?chat=${chat.id}`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    const opener =
      width === 412
        ? page.locator('.chat-menu > summary')
        : page.locator('.workspace-header').getByRole('button', { name: '채팅 설정', exact: true });
    await openChatSettings(page);
    const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
    const close = dialog.getByRole('button', { name: '채팅 설정 닫기', exact: true });
    const tooltip = close.getByRole('tooltip');
    await expect(close).not.toHaveAttribute('title');
    await close.hover();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText('채팅 설정 닫기');
    const bounds = (await tooltip.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
    await tooltip.hover();
    // Observe the native delayed interest loss after leaving the invoker.
    await page.waitForTimeout(700);
    await expect(tooltip).toBeVisible();
    await tooltip.click();
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: info.outputPath(`tooltip-${mode}.png`) });

    await page.mouse.move(width / 2, height / 2);
    await close.focus();
    await page.keyboard.press('Tab');
    await expect(close).not.toBeFocused();
    await expect(tooltip).toBeHidden();
    await close.focus();
    await expect(tooltip).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });
}
