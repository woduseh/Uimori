import { test, expect, type Locator } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import { openChatMenu } from './ui-navigation.js';

// Keep a replayable artifact of the real interactions, not just a final static frame.
test.use({ video: 'on' });

async function settled(surface: Locator) {
  await expect.poll(() => surface.evaluate((node) => node.getAnimations().length)).toBe(0);
  await expect(surface).toHaveCSS('opacity', '1');
  await expect(surface).toHaveCSS('transform', 'none');
}

// Risks: silent CSS failure, visible reduced motion, clipped sheets, lingering transforms,
// delayed close, lost focus/drafts and failure to replay an entrance after immediate re-open.
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
      if (motion === 'no-preference') await expect(menu).toHaveAttribute('data-motion-starts', '1');
      else await expect(menu).toHaveCSS('animation-name', 'none');
      await settled(menu);
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
      if (motion === 'no-preference')
        await expect(dialog).toHaveAttribute('data-motion-starts', '1');
      else await expect(dialog).toHaveCSS('animation-name', 'none');
      await settled(dialog);
      const toggle = dialog.getByRole('switch', { name: '대사 줄바꿈', exact: true });
      await toggle.scrollIntoViewIfNeeded();
      const durations = await toggle.evaluate((node) =>
        getComputedStyle(node, '::before').transitionDuration.split(',').map(Number.parseFloat)
      );
      expect(durations.some((value) => value > 0)).toBe(motion === 'no-preference');
      const original = await toggle.isChecked();
      await toggle.focus();
      await page.keyboard.press('Space');
      await expect(toggle).toBeChecked({ checked: !original });
      await page.screenshot({ path: info.outputPath('reading-switch.png') });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();

      // Close the reopened native modal while its entrance can still be running.
      await openReading();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      await openReading();
      await expect(toggle).toBeChecked({ checked: !original });
      if (motion === 'no-preference')
        await expect
          .poll(async () => Number(await dialog.getAttribute('data-motion-starts')))
          .toBeGreaterThan(1);
      else {
        await expect(dialog).not.toHaveAttribute('data-motion-starts');
        await expect(menu).not.toHaveAttribute('data-motion-starts');
      }
      await settled(dialog);
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
