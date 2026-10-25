import { readFile } from 'node:fs/promises';
import { expect, test, type Locator } from '@playwright/test';
import { navigationAction, selectSettingsSection } from './ui-navigation.js';

async function expectReadableOption(option: Locator) {
  const ratio = await option.evaluate((element) => {
    // Canvas resolves CSS Color 4 values as well as ordinary rgb()/hex colors.
    const context = document.createElement('canvas').getContext('2d')!;
    const rgba = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const blend = (front: number[], back: number[]) =>
      front
        .slice(0, 3)
        .map((channel, i) => channel * (front[3] / 255) + back[i] * (1 - front[3] / 255));
    const select = element.closest('select')!;
    const picker = getComputedStyle(select, '::picker(select)');
    let background = blend(
      rgba(getComputedStyle(document.documentElement).backgroundColor),
      [255, 255, 255]
    );
    background = blend(rgba(picker.backgroundColor), background);
    const style = getComputedStyle(element);
    background = blend(rgba(style.backgroundColor), background);
    const foreground = blend(rgba(style.color), background);
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
  expect(ratio, 'native picker option text contrast').toBeGreaterThanOrEqual(4.5);
}

for (const width of [1440, 412]) {
  test(`NATIVE ${width} theme picker keyboard commit, cancellation and persistence`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
    await page.goto('/');
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '일반');
    const mode = page.getByRole('combobox', { name: '앱 화면 테마', exact: true });
    await expect(mode).toHaveCSS('appearance', 'base-select');

    for (const theme of ['dark', 'light'] as const) {
      await mode.click();
      await expect.poll(() => mode.evaluate((element) => element.matches(':open'))).toBe(true);
      await page.keyboard.press(theme === 'dark' ? 'Home' : 'End');
      if (theme === 'dark') await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await expect(mode).toHaveValue(theme);
      await expect(mode).toBeFocused();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem('uimori:theme')))
        .toBe(theme);

      await mode.click();
      await expect.poll(() => mode.evaluate((element) => element.matches(':open'))).toBe(true);
      const options = mode.locator('option');
      for (const option of await options.all()) {
        await expect(option).toBeVisible();
        const box = await option.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBeGreaterThan(0);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height).toBeLessThanOrEqual(900);
        await expectReadableOption(option);
      }
      const selected = mode.locator('option:checked');
      await selected.hover();
      await expectReadableOption(selected);
      await page.screenshot({ path: info.outputPath(`native-picker-${width}-${theme}.png`) });
      await page.keyboard.press('Home');
      await page.keyboard.press('Escape');
      await expect.poll(() => mode.evaluate((element) => element.matches(':open'))).toBe(false);
      await expect(mode).toHaveValue(theme);
      await expect(mode).toBeFocused();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    }

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '일반');
    await expect(mode).toHaveValue('light');
  });
}

test('NATIVE 412 long uploaded font option stays inside the viewport and persists on pointer selection', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 412, height: 900 });
  const title = `긴 한글 본문 글꼴 이름과 공백없는 영문 ${'LongUnbrokenFontFamily'.repeat(6)}`;
  const uploaded = await request.post('/api/fonts', {
    data: {
      title,
      data: (await readFile('tests/fixtures/appearance-synthetic.ttf')).toString('base64'),
    },
  });
  expect(uploaded.ok()).toBe(true);
  const font = (await uploaded.json()) as { id: string };
  try {
    await page.goto('/');
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '테마와 색상');
    const fonts = page.getByRole('region', { name: '글꼴', exact: true });
    const reader = fonts.getByRole('combobox', { name: '본문 글꼴', exact: true });
    const app = fonts.getByRole('combobox', { name: '앱 글꼴', exact: true });
    const originalApp = await app.inputValue();
    const noOverflow = async () => {
      for (const surface of [
        page.locator('html'),
        page.getByRole('dialog', { name: '설정', exact: true }),
        fonts,
        reader,
      ]) {
        expect(
          await surface.evaluate((element) => element.scrollWidth - element.clientWidth)
        ).toBeLessThanOrEqual(1);
      }
      const box = (await reader.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(412);
    };
    await reader.click();
    await expect.poll(() => reader.evaluate((element) => element.matches(':open'))).toBe(true);
    const option = reader.getByRole('option', { name: title, exact: true });
    await expect(option).toBeVisible();
    const box = (await option.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(412);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(900);
    expect(
      await option.evaluate((element) => element.scrollWidth - element.clientWidth)
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath('native-long-font-open-412.png') });
    await option.click();
    await expect(reader).toHaveValue(font.id);
    // Saving disables both selects temporarily; pointer focus is not retained across that save.
    await expect(reader).toBeEnabled();
    await expect(app).toBeEnabled();
    await expect.poll(() => reader.evaluate((element) => element.matches(':open'))).toBe(false);
    await expect(app).toHaveValue(originalApp);
    await expect
      .poll(async () => (await (await request.get('/api/fonts')).json()).preferences.readerFontId)
      .toBe(font.id);
    await noOverflow();
    await page.screenshot({ path: info.outputPath('native-long-font-closed-412.png') });

    await page.reload();
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '테마와 색상');
    await expect(reader).toHaveValue(font.id);
    await expect(app).toHaveValue(originalApp);
    await reader.scrollIntoViewIfNeeded();
    await noOverflow();
  } finally {
    expect((await request.delete(`/api/fonts/${font.id}`)).ok()).toBe(true);
  }
});
