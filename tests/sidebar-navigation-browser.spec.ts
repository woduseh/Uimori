import { MOBILE_WIDTH, DEFAULT_WIDTHS } from './fixtures/browser-viewports.js';
import { expect, test } from '@playwright/test';
import { visibleNavigation } from './ui-navigation.js';

for (const width of DEFAULT_WIDTHS) {
  test(`SIDENAV01 settings and direct workspace navigation stay accessible at ${width}px`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const navigation = await visibleNavigation(page);
    const workspaces = navigation.locator('.sidebar-workspaces');
    const footer = navigation.getByRole('navigation', { name: '앱 탐색', exact: true });
    const settings = footer.getByRole('button', { name: '설정', exact: true });
    const library = footer.getByRole('button', { name: '서재', exact: true });
    const prompts = footer.getByRole('button', { name: '프롬프트', exact: true });
    await expect(workspaces.getByRole('button')).toHaveText(['채팅', '도우미']);
    await expect(footer.getByRole('button')).toHaveCount(3);
    const modes = navigation.getByRole('tablist', { name: '사이드바 보기 방식', exact: true });
    await expect(modes.getByRole('tab')).toHaveText(['봇', /^활동/u]);
    await expect(modes.getByRole('tab', { name: '봇', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    await library.focus();
    await page.keyboard.press('Tab');
    await expect(prompts).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(settings).toBeFocused();
    if (width === MOBILE_WIDTH) {
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
      if (width === MOBILE_WIDTH)
        await expect(page.getByRole('dialog', { name: '탐색', exact: true })).toBeHidden();
      const returned = await visibleNavigation(page);
      await expect(
        returned.getByRole('button', { name: destination, exact: true })
      ).toHaveAttribute('aria-current', 'page');
      await expect(returned.getByRole('button', { name: '설정', exact: true })).toBeVisible();
    }
    await (await visibleNavigation(page))
      .getByRole('button', { name: '도우미', exact: true })
      .click();
    await expect(page.locator('#helper-panel')).toBeVisible();
    await page.locator('#helper-panel').getByRole('button', { name: '서재', exact: true }).click();
    await expect(page.locator('#helper-panel')).toBeHidden();
    expect(errors).toEqual([]);
  });
}
