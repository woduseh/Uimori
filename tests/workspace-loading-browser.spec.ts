import { expect, test } from '@playwright/test';
import { navigationAction, visibleNavigation, selectSettingsSection } from './ui-navigation.js';

for (const width of [412, 1440]) {
  for (const destination of ['서재', '프롬프트']) {
    test(`WORKLOAD ${destination} ${width} delayed loading becomes an error and explicit retry recovers`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      const now = Date.now();
      await page.clock.install({ time: now });
      await page.clock.pauseAt(now + 1000);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let failing = true;
      await page.route('**/api/library?view=summary', async (route) => {
        if (!failing) return route.continue();
        await held;
        await route.fulfill({ status: 503, json: { error: 'Synthetic library read failure' } });
      });
      try {
        await page.goto('/');
        await navigationAction(page, destination);
        await expect(page.getByRole('heading', { name: destination, exact: true })).toBeVisible();
        const loading = page
          .getByRole('status')
          .filter({ hasText: new RegExp(`${destination}.*불러오는 중`) });
        await page.clock.runFor(150);
        await expect(loading).toHaveCount(0);
        await page.clock.fastForward(100);
        await expect(loading).toBeVisible();
        await expect(loading.locator('svg')).toHaveCSS('animation-name', 'activity-spin');
        const box = (await loading.boundingBox())!;
        const body = (await page.locator('.destination-scroll').boundingBox())!;
        expect(Math.abs(box.x + box.width / 2 - body.x - body.width / 2)).toBeLessThan(2);
        // The header and bottom padding account for the small vertical offset.
        expect(Math.abs(box.y + box.height / 2 - body.y - body.height / 2)).toBeLessThan(64);
        await page.screenshot({ path: info.outputPath(`workspace-loading-${width}.png`) });
        release();
        const error = page.getByRole('alert').filter({
          hasText:
            destination === '프롬프트'
              ? '프롬프트 목록을 불러오지 못했어요.'
              : '서재를 불러오지 못했어요.',
        });
        await expect(error).toBeVisible();
        await expect(loading).toHaveCount(0);
        await page.clock.resume();
        failing = false;
        if (width === 1440 && destination === '서재') {
          const nav = await visibleNavigation(page);
          const bots = nav.getByRole('button', { name: '봇', exact: true });
          if ((await bots.getAttribute('aria-expanded')) !== 'true') await bots.click();
          await nav.getByRole('button', { name: '다시 불러오기', exact: true }).click();
        } else if (width === 1440 && destination === '프롬프트') {
          await navigationAction(page, '설정');
          await selectSettingsSection(page, '프로바이더·모델');
          const settings = page.getByRole('dialog', { name: '설정', exact: true });
          await settings.getByRole('button', { name: '다시 불러오기', exact: true }).click();
          await expect(settings.getByTestId('connection-editor')).toBeVisible();
          await page.keyboard.press('Escape');
        } else {
          await page
            .locator('.destination-scroll')
            .getByRole('button', { name: '다시 불러오기', exact: true })
            .click();
        }
        await expect(error).toHaveCount(0);
        await expect(
          destination === '서재'
            ? page.getByRole('tabpanel', { name: '봇', exact: true })
            : page.getByTestId('prompt-library')
        ).toBeVisible();
        await expect(
          page.getByRole('alert').filter({ hasText: '서버 작업을 완료하지 못했어요. (503)' })
        ).toHaveCount(0);
      } finally {
        release();
        await page.unrouteAll({ behavior: 'wait' });
      }
    });
  }
}
