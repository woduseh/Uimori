import { test, expect, type Locator } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import { openChatMenu } from './ui-navigation.js';

// Keep a replayable artifact of the real interactions, not just a final static frame.
test.use({ video: 'on' });

async function settled(surface: Locator) {
  await expect(surface).toHaveCSS('animation-name', 'none');
  await expect.poll(() => surface.evaluate((node) => node.getAnimations().length)).toBe(0);
  await expect(surface).toHaveCSS('opacity', '1');
  await expect(surface).toHaveCSS('transform', 'none');
}

async function expectHairline(surface: Locator) {
  const border = await surface.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      token: style.getPropertyValue('--hairline').trim(),
      width: Number.parseFloat(style.borderTopWidth),
      style: style.borderTopStyle,
    };
  });
  expect(Number.parseFloat(border.token)).toBe(0.5);
  expect(border.style).toBe('solid');
  // Chromium rounds a half CSS pixel to a device pixel at DPR 1.
  expect(border.width).toBeGreaterThanOrEqual(0.5);
  expect(border.width).toBeLessThanOrEqual(1);
}

// Risks: decorative motion returning, clipped sheets, lingering transforms,
// delayed close and lost focus/drafts after immediate re-open.
for (const width of [412, 1440]) {
  for (const motion of ['no-preference', 'reduce'] as const) {
    test(`MOTION ${width} ${motion} menus, native dialogs and switches preserve interaction`, async ({
      page,
      request,
    }, info) => {
      const height = width === 412 ? 844 : 1000;
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ reducedMotion: motion });
      const response = await postFixtureChat(request, { data: { title: '모션 검증용 서재' } });
      expect(response.ok()).toBe(true);
      const chat = await response.json();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`/?chat=${chat.id}`);
      const composer = page.getByLabel('다음 장면 요청', { exact: true });
      await composer.fill('조작부를 열고 닫아도 남아야 하는 초안');
      // Observe browser-produced events without replacing app state or shortening durations.
      await page.evaluate(() => {
        document.addEventListener('animationstart', (event) => {
          const node = event.target;
          if (node instanceof HTMLElement && node.matches('.app-dialog, .action-menu-body'))
            node.dataset.motionStarts = String(Number(node.dataset.motionStarts ?? 0) + 1);
        });
      });
      const trigger = page.locator('.chat-menu > summary');
      const menu = await openChatMenu(page);
      await expect(menu).toBeVisible();
      await settled(menu);
      await expect(menu).not.toHaveAttribute('data-motion-starts');
      await expectHairline(menu);
      await expect(menu.getByRole('button', { name: '읽기 설정', exact: true })).toHaveCSS(
        'font-size',
        '14px'
      );
      const box = (await menu.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
      if (width === 412) expect(box.y + box.height).toBeGreaterThanOrEqual(height - 24);
      await page.screenshot({ path: info.outputPath('menu.png') });
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(trigger).toBeFocused();

      const openReading = async () => {
        const actions = await openChatMenu(page);
        await actions.getByRole('button', { name: '읽기 설정', exact: true }).click();
      };
      await openReading();
      const dialog = page.getByRole('dialog', { name: '읽기 설정', exact: true });
      await expect(dialog).toBeVisible();
      await settled(dialog);
      await expect(dialog).not.toHaveAttribute('data-motion-starts');
      await expectHairline(dialog);
      await expect(dialog.getByRole('heading', { name: '읽기 설정', exact: true })).toHaveCSS(
        'font-size',
        '16px'
      );
      await expect(dialog.locator('.reading-settings-footer small')).toHaveCSS('font-size', '12px');
      const toggle = dialog.getByRole('switch', { name: '대사 줄바꿈', exact: true });
      await toggle.scrollIntoViewIfNeeded();
      const transition = await toggle.evaluate((node) => {
        const style = getComputedStyle(node, '::before');
        return {
          durations: style.transitionDuration.split(',').map(Number.parseFloat),
          easing: style.transitionTimingFunction.split(',').map((value) => value.trim()),
        };
      });
      expect(
        transition.durations.every((value) => value === (motion === 'reduce' ? 0 : 0.25))
      ).toBe(true);
      if (motion === 'no-preference')
        expect(transition.easing.every((value) => value === 'ease-out')).toBe(true);
      const original = await toggle.isChecked();
      if (width === 412) {
        const target = (await toggle.boundingBox())!;
        expect(target.width).toBeGreaterThanOrEqual(44);
        expect(target.height).toBeGreaterThanOrEqual(44);
        // The space above and below the visual track must also toggle the native input.
        await toggle.click({ position: { x: target.width / 2, y: 2 } });
        await expect(toggle).toBeChecked({ checked: !original });
        await toggle.click({ position: { x: target.width / 2, y: target.height - 2 } });
        await expect(toggle).toBeChecked({ checked: original });
      }
      await toggle.focus();
      await page.keyboard.press('Space');
      await expect(toggle).toBeChecked({ checked: !original });
      await expect(toggle).toHaveCSS('outline-style', 'solid');
      const focusWidth = await toggle.evaluate((node) =>
        Number.parseFloat(getComputedStyle(node).outlineWidth)
      );
      expect(focusWidth).toBeGreaterThanOrEqual(0.5);
      expect(focusWidth).toBeLessThanOrEqual(1);
      await page.screenshot({ path: info.outputPath('reading-switch.png') });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();

      // Immediate dismissal and re-entry must preserve the setting and opener focus.
      await openReading();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      await openReading();
      await expect(toggle).toBeChecked({ checked: !original });
      await settled(dialog);
      await expect(dialog).not.toHaveAttribute('data-motion-starts');
      await expect(menu).not.toHaveAttribute('data-motion-starts');
      await toggle.setChecked(original);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(composer).toHaveValue('조작부를 열고 닫아도 남아야 하는 초안');
      await composer.click();
      await expect(composer).toBeFocused();
      expect(errors).toEqual([]);
    });
  }
}
