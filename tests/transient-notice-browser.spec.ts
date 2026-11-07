import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { fixtureBotInput, postFixtureChat } from './fixtures/chat.js';
import { editLibraryContent, navigationAction, openChatMenu, openHelper } from './ui-navigation.js';

async function chat(request: APIRequestContext, title: string) {
  const response = await postFixtureChat(request, {
    data: { title: `${title} ${crypto.randomUUID()}` },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as { id: string };
}

async function expectAbove(notice: Locator, input: Locator) {
  const [noticeBox, inputBox] = await Promise.all([notice.boundingBox(), input.boundingBox()]);
  expect(noticeBox).not.toBeNull();
  expect(inputBox).not.toBeNull();
  expect(noticeBox!.y).toBeGreaterThanOrEqual(0);
  expect(noticeBox!.y + noticeBox!.height).toBeLessThanOrEqual(inputBox!.y + 1);
}

async function expectBottom(page: Page, notice: Locator, inset: number) {
  const box = (await notice.boundingBox())!;
  expect(Math.abs(box.y + box.height - (page.viewportSize()!.height - inset))).toBeLessThanOrEqual(
    1
  );
}

test('NOTICE01 feedback follows a growing draft and keeps focus until it expires', async ({
  page,
  request,
}, info) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 320, height: 900 });
  const item = await chat(request, '이전 요청 확인');
  let calls = 0;
  await page.route(`**/api/chats/${item.id}/runs`, async (route) => {
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    if (++calls === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await page.goto(`/?chat=${item.id}`);
  const input = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
  await input.fill('먼저 접수할 요청');
  await page.getByRole('button', { name: '원문 생성', exact: true }).click();
  await expect(page.getByRole('button', { name: '이전 요청 확인', exact: true })).toBeVisible();
  await input.fill('남겨 둘 짧은 초안');
  await page.getByRole('button', { name: '이전 요청 확인', exact: true }).click();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
  await page
    .getByRole('dialog', { name: '이전 요청 접수 확인', exact: true })
    .getByRole('button', { name: '접수 확인', exact: true })
    .click();
  const notice = page.locator('.transient-notice');
  const dock = page.locator('.composer-dock');
  await expect(notice).toContainText('이전 요청이 접수됐어요.');
  await expectAbove(notice, dock);
  const shortTop = (await dock.boundingBox())!.y;
  await input.focus();
  const draft = '보존할 새 초안이에요.\n'.repeat(35);
  await input.fill(draft);
  expect((await dock.boundingBox())!.y).toBeLessThan(shortTop);
  await expectAbove(notice, dock);
  await page.setViewportSize({ width: 320, height: 360 });
  await expectAbove(notice, dock);
  await input.evaluate((node: HTMLTextAreaElement) => {
    node.scrollTop = node.scrollHeight;
  });
  expect(await input.evaluate((node: HTMLTextAreaElement) => node.scrollTop)).toBeGreaterThan(0);
  await expect(input).toHaveValue(draft);
  await expect(input).toBeFocused();
  await page.screenshot({ path: info.outputPath('notice-short-viewport.png') });
  await page.clock.fastForward(4100);
  await expect(notice).toHaveCount(0);
  await expect(input).toBeFocused();
  expect(calls).toBe(2);
});

test('NOTICE02 modal, mobile helper, and docked helper keep notices accessible', async ({
  page,
  request,
}, info) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const item = await chat(request, `도우미 알림 ${width}`);
    await page.goto(`/?chat=${item.id}`);
    await openHelper(page);
    const panel = page.locator('#helper-panel');
    await panel.getByLabel('도우미 대화 관리', { exact: true }).click();
    await panel.getByRole('button', { name: '도우미 말투 설정', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '도우미 설정', exact: true });
    await dialog.getByLabel('도우미 말투', { exact: true }).fill('저장할 도우미 말투');
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
    await dialog.getByRole('button', { name: '도우미 설정 저장', exact: true }).click();
    const notice = page.locator('.transient-notice');
    await expect(notice).toContainText('도우미 말투를 저장했어요.');
    await expect(page.locator('dialog:modal')).toHaveCount(1);
    await expectBottom(page, notice, width === 320 ? 16 : 24);
    await dialog.getByRole('button', { name: '도우미 설정 닫기', exact: true }).click();
    const target =
      width === 320 ? panel.locator('.helper-composer') : page.locator('.composer-dock');
    await expectAbove(notice, target);
    await page.screenshot({ path: info.outputPath(`notice-helper-${width}.png`) });
    if (width === 320) {
      const helperInput = panel.getByLabel('도우미에게 요청', { exact: true });
      const draft = '보존할 도우미 요청이에요. '.repeat(50);
      await helperInput.fill(draft);
      await helperInput.focus();
      await page.setViewportSize({ width: 320, height: 360 });
      await expectAbove(notice, target);
      await helperInput.evaluate((node: HTMLTextAreaElement) => {
        node.scrollTop = node.scrollHeight;
      });
      expect(
        await helperInput.evaluate((node: HTMLTextAreaElement) => node.scrollTop)
      ).toBeGreaterThan(0);
      await expect(helperInput).toHaveValue(draft);
      await expect(helperInput).toBeFocused();
      await page.setViewportSize({ width: 320, height: 900 });
      await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
      const menu = await openChatMenu(page);
      await menu.getByRole('button', { name: '집중 읽기', exact: true }).click();
      await expect(page.locator('.composer-dock')).toBeHidden();
      await expectBottom(page, notice, 16);
    }
    await page.clock.resume();
  }
});

test('NOTICE03 resource save keeps the bottom position without a composer', async ({
  page,
  request,
}) => {
  const title = `알림 자료 ${crypto.randomUUID().slice(0, 8)}`;
  const response = await request.post('/api/content', { data: fixtureBotInput(title) });
  expect(response.ok(), await response.text()).toBe(true);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/');
  await navigationAction(page, '봇');
  await editLibraryContent(page, title);
  const editor = page.getByRole('region', { name: '자료 상세', exact: true });
  await editor.getByLabel('Risu 자료 이름', { exact: true }).fill(`${title} 변경`);
  await editor.getByRole('button', { name: '변경사항 저장', exact: true }).click();
  const notice = page.locator('.transient-notice');
  await expect(notice).toBeVisible();
  await expect(page.locator('.composer-dock')).toHaveCount(0);
  await expectBottom(page, notice, 16);
});
