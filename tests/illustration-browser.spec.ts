import { test, expect, type APIRequestContext } from '@playwright/test';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import type { Illustration, IllustrationSettings } from '../core/illustration.js';
import { postFixtureChat } from './fixtures/chat.js';
import { navigationAction, openSourceActions, selectSettingsSection } from './ui-navigation.js';

test.setTimeout(60000);

async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${id}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function seed(request: APIRequestContext) {
  const created = await postFixtureChat(request, {
    data: { title: `Illustration synthetic ${Date.now()}` },
  });
  expect(created.ok()).toBeTruthy();
  const chat = (await created.json()) as Chat;
  expect(
    (
      await request.patch(`/api/chats/${chat.id}/settings`, {
        data: { ...chat.settings, translation: false, status: false, expectedSettingsRevision: 1 },
      })
    ).ok()
  ).toBeTruthy();
  const before = await detail(request, chat.id);
  const started = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: 'Synthetic scene: a lantern lights the quiet river.',
      expectedRevision: before.chat.headRevision,
      expectedSettingsRevision: before.chat.settingsRevision,
      idempotencyKey: `illustration-${chat.id}`,
    },
  });
  expect(started.ok()).toBeTruthy();
  const run = (await started.json()) as Run;
  await expect
    .poll(
      async () => (await detail(request, chat.id)).runs.find((item) => item.id === run.id)?.status
    )
    .toBe('completed');
  const after = await detail(request, chat.id);
  return { chat, source: after.sources.find((item) => item.runId === run.id)! };
}
async function settings(request: APIRequestContext, patch: Partial<IllustrationSettings>) {
  const current = await request.get('/api/illustration-settings');
  expect(current.ok()).toBeTruthy();
  const { revision, ...body } = (await current.json()) as IllustrationSettings;
  const saved = await request.put('/api/illustration-settings', {
    data: { expectedRevision: revision, ...body, ...patch },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  return (await saved.json()) as IllustrationSettings;
}
async function illustrations(request: APIRequestContext, chatId: string) {
  const response = await request.get(`/api/chats/${chatId}/illustrations`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Illustration[];
}
const byStatus = (status: string) => `[data-testid="illustration"][data-status="${status}"]`;

test('ILUI01 scene menu requests an illustration, shows the stored image, retries a failure and deletes', async ({
  page,
  request,
}, info) => {
  const { chat, source } = await seed(request);
  await settings(request, {
    generator: 'fixture',
    automatic: false,
    maxPerSource: 3,
    maxAutoRetries: 0,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  const scene = page.getByTestId('source').first();
  await expect(scene).toBeVisible();
  await expect(page.getByTestId('illustrations')).toHaveCount(0);
  await openSourceActions(scene);
  const illustrate = page.getByTestId('illustrate');
  await expect(illustrate).toHaveText(/삽화 생성/u);
  await illustrate.click();
  const strip = page.getByTestId('illustrations').filter({ visible: true });
  await expect(strip).toHaveCount(1);
  const card = strip.getByTestId('illustration').first();
  await expect(card).toHaveAttribute('data-status', 'completed');
  const image = card.locator('img');
  await expect(image).toBeVisible();
  expect(
    await image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)
  ).toBe(true);
  await expect(card).toContainText('모의 삽화');
  await expect(card).toContainText('직접 요청');
  const stored = await illustrations(request, chat.id);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({
    status: 'completed',
    sourceRevision: source.id,
    origin: 'manual',
  });
  // Persisted server-side: a reload shows the same illustration without another request.
  await page.reload();
  await expect(page.getByTestId('illustration').first()).toHaveAttribute(
    'data-status',
    'completed'
  );
  const failing = await request.post(`/api/sources/${source.id}/illustrations`, {
    data: { fixture: { failures: 1 } },
  });
  expect(failing.ok()).toBeTruthy();
  const failedCard = page.locator(byStatus('failed'));
  await expect(failedCard).toHaveCount(1);
  await expect(failedCard).toContainText('모의 실패예요');
  await expect(failedCard).toContainText('FIXTURE_FAILURE');
  await failedCard.getByRole('button', { name: /다시 요청/u }).click();
  await expect(page.locator(byStatus('completed'))).toHaveCount(2);
  await page
    .getByTestId('illustration')
    .last()
    .getByRole('button', { name: /삽화 삭제/u })
    .click();
  const confirm = page.getByRole('alertdialog', { name: '삭제 확인', exact: true });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '영구 삭제', exact: true }).click();
  await expect(page.getByTestId('illustration')).toHaveCount(1);
  expect(await illustrations(request, chat.id)).toHaveLength(1);
  await page.screenshot({ path: info.outputPath('illustration-desktop.png') });
  // The illustration strip never rewrote the story text.
  expect((await detail(request, chat.id)).sources[0].text).toBe(source.text);
});

test('ILUI02 mobile settings save illustration limits with CAS and expose the generator choice', async ({
  page,
  request,
}, info) => {
  await seed(request);
  const before = await settings(request, { generator: 'none', maxPerSource: 2 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '삽화');
  const section = page.getByRole('region', { name: '삽화 설정', exact: true });
  await expect(section).toBeVisible();
  const generator = section.getByLabel('삽화 생성기', { exact: true });
  await expect(generator).toHaveValue('none');
  await generator.selectOption('fixture');
  await expect(section.getByLabel('응답 완료 후 자동 삽화 생성', { exact: true })).toBeVisible();
  const limit = section.getByLabel('장면당 최대 삽화 개수', { exact: true });
  await limit.fill('3');
  await section.getByLabel('자동 재요청 횟수', { exact: true }).fill('2');
  await section.getByRole('button', { name: '삽화 설정 저장', exact: true }).click();
  await expect(
    section.getByRole('status').filter({ hasText: '삽화 설정을 저장했어요' })
  ).toBeVisible();
  const saved = await request.get('/api/illustration-settings');
  expect((await saved.json()) as IllustrationSettings).toMatchObject({
    generator: 'fixture',
    maxPerSource: 3,
    maxAutoRetries: 2,
    revision: before.revision + 1,
  });
  // A concurrent save elsewhere is rejected by CAS; the stale draft stays until it reloads.
  await settings(request, { styleGuidance: 'ink wash' });
  await limit.fill('4');
  await section.getByRole('button', { name: '삽화 설정 저장', exact: true }).click();
  await expect(section.getByRole('alert').filter({ hasText: '초안은 유지했어요' })).toBeVisible();
  await expect(limit).toHaveValue('4');
  await section.getByRole('button', { name: '저장된 설정 다시 불러오기', exact: true }).click();
  const reloadDialog = page.getByRole('alertdialog', { name: '삽화 설정 다시 불러오기' });
  await expect(reloadDialog.getByRole('button', { name: '계속 편집' })).toBeFocused();
  await reloadDialog.getByRole('button', { name: '계속 편집' }).click();
  await expect(limit).toHaveValue('4');
  await section.getByRole('button', { name: '저장된 설정 다시 불러오기', exact: true }).click();
  await page.route('**/api/illustration-settings', async (route) => {
    if (route.request().method() === 'GET')
      await route.fulfill({ status: 503, body: 'unavailable' });
    else await route.continue();
  });
  await reloadDialog.getByRole('button', { name: '초안 버리고 불러오기' }).click();
  await expect(reloadDialog.getByRole('alert')).toContainText('초안은 유지했어요');
  await expect(limit).toHaveValue('4');
  await page.unroute('**/api/illustration-settings');
  await reloadDialog.getByRole('button', { name: '초안 버리고 불러오기' }).click();
  await expect(section.getByLabel('삽화 그림 지침', { exact: true })).toHaveValue('ink wash');
  await expect(page.locator('body')).not.toHaveCSS('overflow-x', 'scroll');
  await page.screenshot({ path: info.outputPath('illustration-settings-mobile.png') });
});

test('ILUI03 illustration editors use full width and seconds preserve stored milliseconds', async ({
  page,
  request,
}, info) => {
  await seed(request);
  await settings(request, { generator: 'none' });
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '삽화');
  const section = page.getByRole('region', { name: '삽화 설정', exact: true });
  await section.getByLabel('삽화 생성기', { exact: true }).selectOption('comfyui');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const label of [
      '삽화 그림 지침',
      'ComfyUI 네거티브 프롬프트 지침',
      'ComfyUI 워크플로 JSON',
    ]) {
      const field = section.getByLabel(label, { exact: true });
      const bounds = await field.evaluate((node) => {
        const fieldset = node.closest('fieldset')!;
        const css = getComputedStyle(fieldset);
        return {
          actual: node.getBoundingClientRect().width,
          available:
            fieldset.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight),
        };
      });
      expect(Math.abs(bounds.actual - bounds.available)).toBeLessThan(3);
    }
    const toggle = section.getByRole('switch', { name: '응답 완료 후 자동 삽화 생성' });
    const offset = await toggle.evaluate((node) => {
      const a = node.getBoundingClientRect(),
        b = node.parentElement!.getBoundingClientRect();
      return Math.abs(a.y + a.height / 2 - b.y - b.height / 2);
    });
    expect(offset).toBeLessThan(2);
    await page.screenshot({ path: info.outputPath(`illustration-form-${width}.png`) });
    await section.getByLabel('확인 간격 (초)', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`illustration-comfyui-${width}.png`) });
  }
  await section.getByLabel('시간 제한 (초)', { exact: true }).fill('60');
  await section.getByLabel('확인 간격 (초)', { exact: true }).fill('0.25');
  await section.getByLabel('삽화 생성기', { exact: true }).selectOption('none');
  await section.getByRole('button', { name: '삽화 설정 저장', exact: true }).click();
  await expect(
    section.getByRole('status').filter({ hasText: '삽화 설정을 저장했어요' })
  ).toBeVisible();
  const saved = await (await request.get('/api/illustration-settings')).json();
  expect(saved.comfyui).toMatchObject({ timeoutMs: 60000, pollIntervalMs: 250 });
  await page.route('**/api/illustration-settings', (route) =>
    route.fulfill({ status: 503, body: 'unavailable' })
  );
  await section.getByRole('button', { name: '저장된 설정 다시 불러오기' }).click();
  await expect(section.getByRole('status')).toContainText('설정을 불러오지 못했어요');
  await page.unroute('**/api/illustration-settings');
  await section.getByLabel('삽화 그림 지침').fill('preserve draft');
  await section.getByRole('button', { name: '저장된 설정 다시 불러오기' }).click();
  const guard = page.getByRole('alertdialog', { name: '삽화 설정 다시 불러오기' });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(guard.getByRole('button', { name: '계속 편집' })).toBeFocused();
    await page.screenshot({ path: info.outputPath(`illustration-discard-${width}.png`) });
  }
  await page.keyboard.press('Escape');
  await expect(guard).toBeHidden();
  await expect(section.getByLabel('삽화 그림 지침')).toHaveValue('preserve draft');
});
