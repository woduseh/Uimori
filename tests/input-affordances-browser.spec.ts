import { test, expect } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import { openChatMenu, openChatSettings, selectChatSettingsSection } from './ui-navigation.js';

test('INPUTUI02 native light dismiss distinguishes a drag and preserves dirty chat settings', async ({
  page,
  request,
}, info) => {
  const created = await postFixtureChat(request, {
    data: { title: '바깥 클릭 합성 채팅' },
  });
  expect(created.ok()).toBe(true);
  const chat = await created.json();
  const before = await (await request.get(`/api/chats/${chat.id}`)).json();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/?chat=${chat.id}`);
  const composer = page.getByLabel('다음 장면 요청', { exact: true });
  await composer.fill('설정 바깥을 눌러도 유지할 미전송 요청');
  await (await openChatMenu(page)).getByRole('button', { name: '읽기 설정', exact: true }).click();
  const reading = page.getByRole('dialog', { name: '읽기 설정', exact: true });
  await expect(reading).toBeVisible();
  const rect = (await reading.boundingBox())!;
  expect(rect.x).toBeGreaterThan(4);
  const title = (await reading
    .getByRole('heading', { name: '읽기 설정', exact: true })
    .boundingBox())!;
  await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2);
  await page.mouse.down();
  await page.mouse.move(4, 4, { steps: 8 });
  await page.mouse.up();
  await expect(reading).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(reading).toBeHidden();
  await expect(composer).toHaveValue('설정 바깥을 눌러도 유지할 미전송 요청');

  await openChatSettings(page);
  await selectChatSettingsSection(page, '생성 설정');
  const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
  await dialog.getByText('고급 실행 설정', { exact: true }).click();
  const calls = dialog.getByRole('spinbutton', { name: '작업당 모델 호출 한도', exact: true });
  const original = await calls.inputValue();
  const draft = original === '17' ? '18' : '17';
  await calls.fill(draft);
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method()))
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  const settingsRect = (await dialog.boundingBox())!;
  expect(settingsRect.x).toBeGreaterThan(4);
  await page.mouse.click(4, 4);
  const confirm = page.getByRole('alertdialog', { name: '미저장 채팅 설정 확인', exact: true });
  await expect(confirm).toBeVisible();
  await page.screenshot({ path: info.outputPath('native-dismiss-dirty-confirmation.png') });
  await confirm.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(calls).toHaveValue(draft);
  await page.mouse.click(4, 4);
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '초안 버리고 닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(composer).toHaveValue('설정 바깥을 눌러도 유지할 미전송 요청');
  expect(writes).toEqual([]);
  const after = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(after.chat.settings).toEqual(before.chat.settings);
  expect(after.chat.settingsRevision).toBe(before.chat.settingsRevision);
  expect(after.profile).toEqual(before.profile);
});
