import { MOBILE_WIDTH, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { visualReview } from './fixtures/visual-review.js';
import { test, expect } from './fixtures/browser-test.js';
import { fixtureBotInput } from './fixtures/chat.js';
import {
  navigationAction,
  selectSettingsSection,
  startProviderConnection,
} from './ui-navigation.js';

test('SCUI05 global lore defaults are saved and copied only to new chats', async ({
  page,
  request,
}) => {
  const original = await (await request.get('/api/lore-context-defaults')).json();
  const created = await request.post('/api/content', {
    data: fixtureBotInput('로어 기본값 합성 봇'),
  });
  expect(created.ok()).toBe(true);
  const bot = await created.json();
  const firstResponse = await request.post('/api/chats', {
    data: { botId: bot.id, title: '기본값 변경 전 채팅' },
  });
  expect(firstResponse.ok()).toBe(true);
  const first = await firstResponse.json();
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '로어 컨텍스트');
  const settings = page.getByRole('dialog', { name: '설정', exact: true });
  const section = settings.getByRole('region', { name: '로어 컨텍스트 기본값', exact: true });
  const reset = section.getByRole('button', { name: '초기값으로 되돌리기', exact: true });
  await expect(reset).toBeHidden();
  await section.getByText('선별 기준과 용량', { exact: true }).click();
  await expect(reset).toBeVisible();
  await section.getByText('선별 기준과 용량', { exact: true }).click();
  await expect(reset).toBeHidden();
  await section.getByText('선별 기준과 용량', { exact: true }).click();
  const retained = section.getByLabel('조회 로어 토큰 한도', { exact: true });
  await expect(retained).toBeVisible();
  await expect(retained).toHaveValue(String(original.maxRetainedTokens));
  const nextLimit = original.maxRetainedTokens === 24_000 ? 20_000 : 24_000;
  await retained.fill(String(nextLimit));
  await section.getByRole('button', { name: '로어 컨텍스트 기본값 저장', exact: true }).click();
  await expect(
    page.locator('.transient-notice[role="status"]').filter({ hasText: '새 채팅부터 적용돼요' })
  ).toBeVisible();
  const secondResponse = await request.post('/api/chats', {
    data: { botId: bot.id, title: '기본값 변경 후 채팅' },
  });
  expect(secondResponse.ok()).toBe(true);
  const second = await secondResponse.json();
  const firstDetail = await (await request.get(`/api/chats/${first.id}`)).json();
  const secondDetail = await (await request.get(`/api/chats/${second.id}`)).json();
  expect(firstDetail.profile.loreContext.maxRetainedTokens).toBe(original.maxRetainedTokens);
  expect(secondDetail.profile.loreContext.maxRetainedTokens).toBe(nextLimit);
  const saved = await (await request.get('/api/lore-context-defaults')).json();
  const { revision: _revision, ...policy } = original;
  const restored = await request.put('/api/lore-context-defaults', {
    data: { expectedRevision: saved.revision, ...policy },
  });
  expect(restored.ok()).toBe(true);
});

test('SCUI02 settings back, resize and close preserve provider and chat drafts until explicit discard', async ({
  page,
  request,
}, info) => {
  const created = await request.post('/api/content', {
    data: fixtureBotInput('설정 초안 보존 합성 봇'),
  });
  expect(created.ok()).toBe(true);
  const bot = await created.json();
  const response = await request.post('/api/chats', {
    data: { botId: bot.id, title: '설정 초안 보존 합성 채팅' },
  });
  expect(response.ok()).toBe(true);
  const chat = await response.json();
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  await page.goto(`/?chat=${chat.id}`);
  const composer = page.getByLabel('다음 장면 요청', { exact: true });
  await composer.fill('계속 보존할 사용자 요청');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '프로바이더와 모델');
  await startProviderConnection(page);
  await page.getByRole('button', { name: /OpenAI Responses/ }).click();
  const name = page
    .getByRole('form', { name: '프로바이더 편집 양식' })
    .getByLabel('프로바이더 이름', { exact: true });
  await name.fill('아직 저장하지 않은 합성 연결');
  await page.goBack();
  await expect(name).toBeHidden();
  await page.goBack();
  const dialog = page.getByRole('dialog', { name: '설정', exact: true });
  await expect(dialog.locator('.settings-navigation')).toBeVisible();
  await expect(
    dialog
      .locator('.settings-navigation')
      .getByRole('button', { name: '프로바이더와 모델', exact: true })
  ).toHaveText('프로바이더와 모델');
  await expect(dialog.getByRole('tabpanel')).toHaveCount(0);
  await page.goBack();
  const confirm = page.getByRole('alertdialog', { name: '미저장 설정 확인', exact: true });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '계속 편집', exact: true }).click();
  await selectSettingsSection(page, '프로바이더와 모델');
  await dialog
    .getByRole('button', {
      name: '프로바이더 편집 이어 하기: 아직 저장하지 않은 합성 연결',
      exact: true,
    })
    .click();
  await expect(name).toHaveValue('아직 저장하지 않은 합성 연결');
  await name.focus();
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await expect(name).toBeFocused();
  await selectSettingsSection(page, '일반');
  await selectSettingsSection(page, '프로바이더와 모델');
  await expect(name).toHaveValue('아직 저장하지 않은 합성 연결');
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  await expect(name).toBeVisible();
  await dialog.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await expect(confirm).toBeVisible();
  if (visualReview)
    await page.screenshot({ path: info.outputPath(`settings-unsaved-${MOBILE_WIDTH}.png`) });
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(name).toHaveValue('아직 저장하지 않은 합성 연결');
  await dialog.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await confirm.getByRole('button', { name: '초안 버리고 닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(composer).toHaveValue('계속 보존할 사용자 요청');
  await expect(page).toHaveURL(new RegExp(`chat=${chat.id}`));
  const after = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(after.runs).toHaveLength(0);
  expect(after.jobs).toHaveLength(0);
});
