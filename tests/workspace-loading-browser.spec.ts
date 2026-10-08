import { expect, test } from '@playwright/test';
import { navigationAction } from './ui-navigation.js';

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
        await page.clock.runFor(50);
        await expect(loading).toHaveCount(0);
        await page.clock.fastForward(250);
        await expect(loading).toBeVisible();
        await expect(loading.locator('svg')).toHaveCSS('animation-name', 'activity-spin');
        const box = (await loading.boundingBox())!;
        expect(box.x + box.width / 2).toBeGreaterThan(width * 0.4);
        expect(box.y + box.height / 2).toBeGreaterThan(250);
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
        await page
          .locator('.destination-scroll')
          .getByRole('button', { name: '다시 불러오기', exact: true })
          .click();
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
