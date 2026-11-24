import { expect, test, type Locator } from '@playwright/test';
import { BUILTIN_PALETTES, DEFAULT_PALETTE_COLORS } from '../core/theme-palettes.js';
import { postFixtureChat } from './fixtures/chat.js';
import { DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { restoreGlobalThemeSelection } from './fixtures/theme-selection.js';

async function expectReadableText(locator: Locator, description: string) {
  await expect(locator).toBeVisible();
  const contrast = await locator.evaluate((element) => {
    const rgb = (color: string) => color.match(/[\d.]+/g)!.map(Number);
    const blend = (foreground: number[], background: number[]) => {
      const alpha = foreground[3] ?? 1;
      return foreground
        .slice(0, 3)
        .map((channel, i) => channel * alpha + background[i] * (1 - alpha));
    };
    const ancestors: Element[] = [];
    for (let current: Element | null = element; current; current = current.parentElement)
      ancestors.unshift(current);
    let background = [255, 255, 255];
    for (const ancestor of ancestors)
      background = blend(rgb(getComputedStyle(ancestor).backgroundColor), background);
    const foreground = blend(rgb(getComputedStyle(element).color), background);
    const luminance = (channels: number[]) => {
      const linear = channels.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };
    const values = [luminance(foreground), luminance(background)];
    return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
  });
  expect(contrast, description).toBeGreaterThanOrEqual(4.5);
}

test('COLOR selected input language and avatar text stay readable in default and named palettes', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 412, height: 844 });
  await page.addInitScript(() => localStorage.setItem('uimori:theme', 'system'));
  const created = await postFixtureChat(request, { data: { title: '선택 색상 검증' } });
  expect(created.ok()).toBe(true);
  const chat = await created.json();
  const before = await (await request.get('/api/themes')).json();
  const layout = await request.post('/api/themes/selection', {
    data: {
      scope: 'global',
      themeId: 'builtin:forest',
      expectedRevision: before.preferences.revision,
    },
  });
  expect(layout.ok()).toBe(true);
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  const composer = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
  await composer.fill('팔레트를 바꿔도 이 요청과 선택한 언어를 유지해요.');
  const menu = page.locator('.input-translation-language-mobile');
  const trigger = menu.locator('summary');
  await trigger.click();
  await menu.getByRole('button', { name: '일본어', exact: true }).click();
  await expect(trigger).toHaveText('JA');
  await expect(trigger).toBeFocused();
  await trigger.click();
  const selected = menu.locator('button[aria-pressed="true"]');
  await expect(selected).toHaveText('일본어');
  await expect(selected).toHaveCSS('font-size', '14px');

  for (const mode of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: mode, reducedMotion: 'reduce' });
    for (const palette of [{ id: 'theme', colors: DEFAULT_PALETTE_COLORS }, ...BUILTIN_PALETTES]) {
      const catalog = await (await request.get('/api/themes')).json();
      const changed = await request.post('/api/themes/selection', {
        data: {
          dimension: 'palette',
          scope: 'global',
          paletteId: palette.id,
          expectedRevision: catalog.preferences.revision,
        },
      });
      expect(changed.ok()).toBe(true);
      await page.evaluate(() => dispatchEvent(new Event('focus')));
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
      await expect
        .poll(() =>
          page
            .locator('html')
            .evaluate((root) => getComputedStyle(root).getPropertyValue('--accent').trim())
        )
        .toBe(palette.colors[mode].accent);
      await expectReadableText(selected, `${palette.id} ${mode}: selected language`);
      await selected.hover();
      await expectReadableText(selected, `${palette.id} ${mode}: hovered selected language`);
      const avatar = page.locator('.content-avatar').filter({ visible: true }).first();
      if (await avatar.count())
        await expectReadableText(avatar, `${palette.id} ${mode}: avatar initial`);
      await expect(menu).toHaveAttribute('open', '');
      await expect(selected).toHaveText('일본어');
      await expect(composer).toHaveValue('팔레트를 바꿔도 이 요청과 선택한 언어를 유지해요.');
      if (palette.id === 'theme' || palette.id === 'forest')
        await page.screenshot({
          path: info.outputPath(`selected-language-${palette.id}-${mode}.png`),
        });
    }
  }
  await selected.press('Escape');
  await expect(menu).not.toHaveAttribute('open');
  await expect(trigger).toBeFocused();
  expect((await (await request.get('/api/themes')).json()).themes).toEqual(before.themes);
  await restoreGlobalThemeSelection(request, before.preferences);
});
