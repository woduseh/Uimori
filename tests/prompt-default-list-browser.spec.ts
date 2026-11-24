import { test, expect, type APIRequestContext } from '@playwright/test';
import type { PromptPreset, PromptRole, PromptWorkspace } from '../core/product.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { visualReview } from './fixtures/visual-review.js';
import { navigationAction } from './ui-navigation.js';

preservePromptWorkspace();

async function preset(request: APIRequestContext, title: string, role: PromptRole) {
  const response = await request.post('/api/prompt-presets', {
    data: { title, role, program: createDefaultRisuPrompt(`Synthetic ${title}`, role) },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as PromptPreset;
}
async function workspace(request: APIRequestContext) {
  return (await (await request.get('/api/prompt-workspace')).json()) as PromptWorkspace;
}

test('PDEF01 the prompt list marks the global defaults and changes one through the saved workspace', async ({
  page,
  request,
}, info) => {
  const prefix = `PDEF01 ${crypto.randomUUID()}`;
  const first = await preset(request, `${prefix} 첫째`, 'main');
  const second = await preset(request, `${prefix} 둘째`, 'main');
  const translation = await preset(request, `${prefix} 번역`, 'translation');
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  const panel = page.getByTestId('prompt-library');
  await panel.getByRole('searchbox', { name: '프롬프트 검색', exact: true }).fill(prefix);
  const row = (item: PromptPreset) => panel.locator(`[data-library-item-id="${item.id}"]`);
  const chooseDefault = async (item: PromptPreset) => {
    await row(item).getByLabel(`${item.title} 메뉴`, { exact: true }).click();
    await row(item).getByRole('button', { name: '기본으로 사용', exact: true }).click();
  };
  await expect(row(second)).toContainText('창작');
  await expect(row(second).locator('.library-default-badge')).toHaveCount(0);

  await chooseDefault(second);
  await expect(row(second).locator('.library-default-badge')).toHaveText('기본 창작');
  await expect(page.locator('.transient-notice')).toContainText(
    `${second.title} 프롬프트를 기본 창작으로 정했어요.`
  );
  expect((await workspace(request)).main.presetId).toBe(second.id);
  await expect(
    panel.getByRole('button', { name: `${second.title} 프롬프트 편집`, exact: true })
  ).toHaveAccessibleDescription('기본 창작');
  await row(second).getByLabel(`${second.title} 메뉴`, { exact: true }).click();
  await expect(row(second).getByRole('button', { name: '기본으로 사용' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.route('**/api/events**', (route) => route.abort());
  await page.evaluate(() => {
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
  });
  const stale = await workspace(request);
  const external = await request.post('/api/prompt-workspace/apply', {
    data: { expectedRevision: stale.revision, role: 'translation', presetId: translation.id },
  });
  expect(external.ok(), await external.text()).toBe(true);
  await chooseDefault(first);
  await expect(page.locator('.dismissible-error')).toBeVisible();
  expect((await workspace(request)).main.presetId).toBe(second.id);
  await expect(row(translation).locator('.library-default-badge')).toHaveText('기본 번역');
  await expect(row(first).locator('.library-default-badge')).toHaveCount(0);

  await chooseDefault(first);
  await expect(row(first).locator('.library-default-badge')).toHaveText('기본 창작');
  await expect(row(second).locator('.library-default-badge')).toHaveCount(0);
  await expect(row(translation).locator('.library-default-badge')).toHaveText('기본 번역');
  const saved = await workspace(request);
  expect([saved.main.presetId, saved.translation.presetId]).toEqual([first.id, translation.id]);
  if (visualReview) await page.screenshot({ path: info.outputPath('prompt-defaults-desktop.png') });
});
