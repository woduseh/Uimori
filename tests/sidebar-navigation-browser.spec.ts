import { expect, test } from '@playwright/test';
import { visibleNavigation } from './ui-navigation.js';

for (const width of [390, 1440]) {
  test(`SIDENAV01 settings and direct workspace navigation stay accessible at ${width}px`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const navigation = await visibleNavigation(page);
    const destinations = navigation.getByRole('navigation', { name: '작업 공간', exact: true });
    const footer = navigation.getByRole('navigation', { name: '앱 탐색', exact: true });
    const settings = footer.getByRole('button', { name: '설정', exact: true });
    const library = destinations.getByRole('button', { name: '서재', exact: true });
    const prompts = destinations.getByRole('button', { name: '프롬프트', exact: true });
    await expect(destinations.getByRole('button')).toHaveText(['서재', '프롬프트']);
    await expect(navigation.getByLabel('앱 메뉴', { exact: true })).toHaveCount(0);
    for (const action of [library, prompts, settings]) {
      await expect(action).toBeVisible();
      await expect(action).toBeInViewport();
      const box = await action.boundingBox();
      expect(box).not.toBeNull();
      if (!box) throw new Error('Sidebar action has no visible bounds');
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    }
    await page.screenshot({ path: info.outputPath(`sidebar-footer-${width}.png`) });

    await library.focus();
    await page.keyboard.press('Tab');
    await expect(prompts).toBeFocused();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`sidebar-menu-${width}.png`) });
    if (width === 390) {
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: '탐색', exact: true })).toBeHidden();
      await expect(page.getByRole('button', { name: '탐색 메뉴', exact: true })).toBeFocused();
      await visibleNavigation(page);
    }

    await settings.click();
    const dialog = page.getByRole('dialog', { name: '설정', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '설정 닫기', exact: true }).click();
    await expect(dialog).toBeHidden();
    for (const destination of ['프롬프트', '서재']) {
      const current = await visibleNavigation(page);
      await current.getByRole('button', { name: destination, exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: destination, exact: true })).toBeVisible();
      if (width === 390)
        await expect(page.getByRole('dialog', { name: '탐색', exact: true })).toBeHidden();
      const returned = await visibleNavigation(page);
      await expect(
        returned.getByRole('button', { name: destination, exact: true })
      ).toHaveAttribute('aria-current', 'page');
      await expect(returned.getByRole('button', { name: '설정', exact: true })).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
}
