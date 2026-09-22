import { expect, test } from '@playwright/test';
import { MOBILE_WIDTH } from './fixtures/browser-viewports.js';
import { navigationAction } from './ui-navigation.js';

test('UIPOLISH01 mobile prompt library keeps a compact toolbar and builtin prompts use a full-screen surface', async ({
  page,
  request,
}, info) => {
  const templateResponse = await request.get('/api/prompt-templates/pheme');
  expect(templateResponse.ok(), await templateResponse.text()).toBe(true);
  const template = await templateResponse.json();
  const seedResponse = await request.post('/api/prompt-presets', {
    data: {
      title: 'UIPOLISH01 seed',
      role: 'main',
      program: template.program,
      values: template.values,
    },
  });
  expect(seedResponse.ok(), await seedResponse.text()).toBe(true);

  await page.setViewportSize({ width: MOBILE_WIDTH, height: 915 });
  await page.goto('/');
  await navigationAction(page, '프롬프트');

  const panel = page.getByTestId('prompt-library');
  const importer = panel.getByRole('button', { name: '프롬프트 가져오기', exact: true });
  const current = panel.getByRole('button', { name: '현재 프롬프트 설정', exact: true });
  const builtin = panel.getByRole('button', { name: '기본 프롬프트', exact: true });
  const create = panel.getByRole('button', { name: '새 프롬프트', exact: true }).first();
  const search = panel.getByRole('searchbox', { name: '프롬프트 검색', exact: true });

  for (const control of [importer, current, builtin, create, search])
    await expect(control).toBeVisible();

  const [importBox, currentBox, builtinBox, createBox, searchBox] = await Promise.all(
    [importer, current, builtin, create, search].map((control) => control.boundingBox())
  );
  for (const box of [importBox, currentBox, builtinBox, createBox, searchBox])
    expect(box).not.toBeNull();

  // Mobile keeps secondary actions and create on one compact row; search gets the next row.
  expect(Math.abs(importBox!.y - currentBox!.y)).toBeLessThan(2);
  expect(Math.abs(currentBox!.y - builtinBox!.y)).toBeLessThan(2);
  expect(Math.abs(builtinBox!.y - createBox!.y)).toBeLessThan(2);
  expect(createBox!.width).toBeLessThanOrEqual(48);
  expect(searchBox!.y).toBeGreaterThan(createBox!.y + createBox!.height - 2);
  expect(
    await panel
      .locator('.library-toolbar')
      .evaluate((node) => node.scrollWidth <= node.clientWidth + 1)
  ).toBe(true);

  await page.screenshot({ path: info.outputPath('prompt-library-mobile-toolbar.png') });

  await builtin.click();
  const dialog = page.getByRole('dialog', { name: '기본 프롬프트', exact: true });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeLessThanOrEqual(1);
  expect(bounds!.y).toBeLessThanOrEqual(1);
  expect(bounds!.width).toBeGreaterThanOrEqual(MOBILE_WIDTH - 1);
  expect(bounds!.height).toBeGreaterThanOrEqual(900);
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);

  await page.screenshot({ path: info.outputPath('prompt-library-mobile-builtin.png') });
});

test('UIPOLISH02 desktop helper owns its open-state controls', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');

  const opener = page.getByRole('button', { name: '도우미 열기', exact: true });
  await expect(opener).toBeVisible();
  await opener.click();

  const panel = page.locator('#helper-panel');
  await expect(panel).toBeVisible();
  await expect(opener).toBeHidden();
  const close = panel.getByRole('button', { name: '도우미 닫기', exact: true });
  await expect(close).toBeVisible();
  await close.click();
  await expect(panel).toBeHidden();
  await expect(opener).toBeVisible();
});
