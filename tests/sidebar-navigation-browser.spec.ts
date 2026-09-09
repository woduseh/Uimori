import { expect, test } from '@playwright/test';
import { navigationAction, visibleNavigation } from './ui-navigation.js';

for (const width of [390, 1440]) {
  test(`SIDENAV01 settings and app menu stay accessible at ${width}px`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const navigation = await visibleNavigation(page);
    const footer = navigation.getByRole('navigation', { name: '앱 탐색', exact: true });
    const settings = footer.getByRole('button', { name: '설정', exact: true });
    const menu = footer.locator('.sidebar-app-menu');
    const trigger = menu.getByLabel('앱 메뉴', { exact: true });
    const body = menu.locator('.action-menu-body');
    await expect(settings).toBeVisible();
    await expect(trigger).toBeVisible();
    await expect(body).toBeHidden();
    const settingsBox = await settings.boundingBox();
    const triggerBox = await trigger.boundingBox();
    expect(settingsBox).not.toBeNull();
    expect(triggerBox).not.toBeNull();
    if (!settingsBox || !triggerBox) throw new Error('Sidebar actions have no visible bounds');
    expect(
      Math.abs(settingsBox.y + settingsBox.height / 2 - triggerBox.y - triggerBox.height / 2)
    ).toBeLessThanOrEqual(1);
    expect(settingsBox.x + settingsBox.width).toBeLessThanOrEqual(triggerBox.x);
    await page.screenshot({ path: info.outputPath(`sidebar-footer-${width}.png`) });

    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(body).toBeVisible();
    await expect(body.getByRole('button')).toHaveText(['서재', '프롬프트']);
    const menuBox = await body.boundingBox();
    expect(menuBox).not.toBeNull();
    if (!menuBox) throw new Error('App menu has no visible bounds');
    expect(menuBox.y).toBeGreaterThanOrEqual(0);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(triggerBox.y);
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`sidebar-menu-${width}.png`) });
    await body.getByRole('button', { name: '서재', exact: true }).focus();
    await page.keyboard.press('Escape');
    await expect(body).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(navigation).toBeVisible();

    await settings.click();
    const dialog = page.getByRole('dialog', { name: '설정', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '설정 닫기', exact: true }).click();
    await expect(dialog).toBeHidden();
    for (const destination of ['프롬프트', '서재']) {
      await navigationAction(page, destination);
      await expect(page.getByRole('heading', { name: destination, exact: true })).toBeVisible();
      const returned = await visibleNavigation(page);
      await expect(returned.locator('.sidebar-app-menu .action-menu-body')).toBeHidden();
    }
    expect(errors).toEqual([]);
  });
}
