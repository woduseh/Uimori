import { test, expect, type APIRequestContext } from '@playwright/test';
import type { ThemeCatalog } from '../core/themes.js';
import { navigationAction, selectSettingsSection } from './ui-navigation.js';

async function read<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`/api${path}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

for (const width of [412]) {
  test(`SDC01 ${width} theme deletion is compact, safely focused and cancellable before confirmation`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '테마와 색상');
    {
      const advanced = page.locator('.theme-advanced:not([open]) > summary');
      if (await advanced.isVisible()) await advanced.click();
    }
    const settings = page.getByRole('dialog', { name: '설정', exact: true });
    await expect(settings.locator('details.theme-sample')).toHaveCount(1);
    const title = `Dialog consistency theme ${width}`;
    await page.getByRole('button', { name: '새 커스텀 테마', exact: true }).click();
    await page.getByLabel('테마 이름', { exact: true }).fill(title);
    await page.getByRole('button', { name: '테마 저장', exact: true }).click();
    await expect(page.getByRole('button', { name: '테마 저장', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '편집 취소', exact: true }).click();
    const menu = page.getByLabel(`${title} 관리`, { exact: true });
    const trigger = page.getByRole('button', { name: `${title} 삭제`, exact: true });
    const dialog = page.getByRole('alertdialog', { name: '테마 삭제', exact: true });
    const cancel = dialog.getByRole('button', { name: '취소', exact: true });
    const remove = dialog.getByRole('button', { name: '삭제', exact: true });
    const catalog = await read<ThemeCatalog>(request, '/themes');
    const theme = catalog.themes.find((item) => item.title === title)!;
    expect(theme).toBeDefined();
    const deleted: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'DELETE' && request.url().endsWith(`/api/themes/${theme.id}`))
        deleted.push(request.url());
    });

    for (const dismissal of ['cancel', 'Escape', 'backdrop'] as const) {
      await menu.click();
      await trigger.click();
      await expect(cancel).toBeFocused();
      if (dismissal === 'cancel') {
        await page.keyboard.press('Tab');
        await expect(remove).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(
          dialog.getByRole('button', { name: '테마 삭제 닫기', exact: true })
        ).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(remove).toBeFocused();
        await cancel.focus();
        await page.screenshot({ path: info.outputPath(`theme-delete-${width}.png`) });
        await page.keyboard.press('Enter');
      } else if (dismissal === 'Escape') await page.keyboard.press('Escape');
      else await page.mouse.click(4, 4);
      await expect(dialog).toBeHidden();
      await expect(settings).toBeVisible();
      await expect(menu).toBeFocused();
      expect(deleted).toEqual([]);
      expect(
        (await read<ThemeCatalog>(request, '/themes')).themes.some((item) => item.id === theme.id)
      ).toBe(true);
    }

    await page.route(`**/api/themes/${theme.id}`, (route) =>
      route.fulfill({ status: 503, json: { error: 'Synthetic theme delete failure' } })
    );
    await menu.click();
    await trigger.click();
    await remove.click();
    await expect(dialog.getByRole('alert')).toContainText('(503)');
    await expect(cancel).toBeEnabled();
    expect(
      (await read<ThemeCatalog>(request, '/themes')).themes.some((item) => item.id === theme.id)
    ).toBe(true);
    await page.unroute(`**/api/themes/${theme.id}`);
    await remove.click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toHaveCount(0);
    await expect(settings).toBeVisible();
    expect(
      (await read<ThemeCatalog>(request, '/themes')).themes.some((item) => item.id === theme.id)
    ).toBe(false);
    expect(deleted).toHaveLength(2);
    await selectSettingsSection(page, '일반');
    await expect(settings.getByLabel('앱 화면 테마')).toBeVisible();
  });
}
