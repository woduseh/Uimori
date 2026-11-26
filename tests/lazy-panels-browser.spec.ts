import { visualReview } from './fixtures/visual-review.js';
import { test, expect } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import { navigationAction, selectChatSettingsSection } from './ui-navigation.js';
import { openChatSettings } from './ui-navigation.js';

test('LAZY03 failed settings script stays local and preserves unsent text', async ({
  page,
  request,
}, info) => {
  const response = await postFixtureChat(request, { data: { title: 'SYNTHETIC_LAZY_FAILURE' } });
  expect(response.ok()).toBeTruthy();
  const chat = await response.json();
  await page.route('**/assets/WorkspacePanels-*.js', (route) => route.abort('failed'));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/?chat=${chat.id}`);
  const draft = page.getByLabel('다음 장면 요청');
  await draft.fill('SYNTHETIC_PRESERVED_AFTER_CHUNK_FAILURE');
  await navigationAction(page, '설정');
  const settings = page.getByRole('dialog', { name: '설정', exact: true });
  await expect(settings.getByRole('alert')).toContainText('불러오지 못했어요');
  if (visualReview)
    await info.attach('settings-load-failure', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  await settings.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await expect(draft).toHaveValue('SYNTHETIC_PRESERVED_AFTER_CHUNK_FAILURE');
  await draft.fill('SYNTHETIC_STILL_EDITABLE');
  await openChatSettings(page);
  const profile = page.getByRole('dialog', { name: '채팅 설정', exact: true });
  await selectChatSettingsSection(page, '사용 자료');
  await expect(profile.getByTestId('profile-editor')).toBeVisible();
  if (visualReview)
    await info.attach('profile-after-settings-failure', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  await page.keyboard.press('Escape');
  await expect(draft).toHaveValue('SYNTHETIC_STILL_EDITABLE');
  expect(errors).toEqual([]);
});
