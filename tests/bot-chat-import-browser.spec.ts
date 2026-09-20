import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { fixtureBotInput } from './fixtures/chat.js';
import { visibleNavigation } from './ui-navigation.js';

async function create(request: APIRequestContext, title: string) {
  const botResponse = await request.post('/api/content', { data: fixtureBotInput(title) });
  expect(botResponse.ok(), await botResponse.text()).toBe(true);
  const bot = await botResponse.json();
  const chatResponse = await request.post('/api/chats', { data: { title, botId: bot.id } });
  expect(chatResponse.ok(), await chatResponse.text()).toBe(true);
  return { bot, chat: await chatResponse.json() };
}

for (const viewport of [
  { width: 2560, height: 1440 },
  { width: 412, height: 915 },
]) {
  test(`BOTIMPORT01 selected bot confirmation and uncertain retry retain identity at ${viewport.width}px`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize(viewport);
    const original = await create(request, `원래 봇 ${randomUUID().slice(0, 6)}`);
    const target = await create(request, `가져올 봇 ${randomUUID().slice(0, 6)}`);
    await page.goto(`/?chat=${target.chat.id}`);
    const navigation = await visibleNavigation(page);
    await navigation
      .getByRole('button', { name: `${target.bot.title} 채팅 목록`, exact: true })
      .hover();
    await navigation.getByLabel(`${target.bot.title} 관리`, { exact: true }).click();
    await navigation.getByRole('button', { name: '채팅 가져오기', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '채팅 가져오기', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(target.bot.title, { exact: true })).toBeVisible();
    expect(
      await dialog.evaluate((node) => node.scrollWidth - node.clientWidth)
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`bot-chat-import-${viewport.width}.png`) });
    await dialog.getByRole('button', { name: /본문만 가져오기/ }).click();
    const transcript = {
      format: 'uimori-chat-transcript',
      version: 2,
      exportedAt: new Date().toISOString(),
      title: '가져온 본문',
      packageAttachments: [{ id: original.bot.id, revision: original.bot.revision, role: 'bot' }],
      entries: [{ request: '첫 요청', text: '원본 장면', translation: '번역 장면' }],
      notes: [],
    };
    const requests: unknown[] = [];
    await page.route('**/api/chats/import-transcript', async (route) => {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) {
        const committed = await route.fetch();
        expect(committed.ok(), await committed.text()).toBe(true);
        await route.abort('failed');
      } else await route.continue();
    });
    // A selected bot that already has another authored role must not be silently removed.
    await dialog.getByLabel('본문 JSON 파일').setInputFiles({
      name: 'role-collision.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          ...transcript,
          packageAttachments: [
            ...transcript.packageAttachments,
            { id: target.bot.id, revision: target.bot.revision, role: 'module' },
          ],
        })
      ),
    });
    await expect(dialog.getByRole('alert')).toContainText(
      '선택한 봇을 다른 역할의 자료로도 사용해요'
    );
    await expect(
      dialog.getByRole('button', { name: '새 채팅으로 가져오기', exact: true })
    ).toHaveCount(0);
    expect(requests).toHaveLength(0);
    await dialog.getByLabel('본문 JSON 파일').setInputFiles({
      name: 'history.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(transcript)),
    });
    await expect(dialog.getByText(`“${target.bot.title}”의 새 채팅으로 가져와요.`)).toBeVisible();
    expect(requests).toHaveLength(0);
    await dialog.getByRole('button', { name: '새 채팅으로 가져오기', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '같은 요청 확인' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('본문 JSON 파일')).toBeDisabled();
    const responseEvent = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/chats/import-transcript') && response.status() === 200
    );
    await dialog.getByRole('button', { name: '같은 요청 확인' }).click();
    const result = await (await responseEvent).json();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(result.created).toBe(false);
    expect(result.chat.botId).toBe(target.bot.id);
    await expect(dialog.getByRole('status')).toContainText('새 채팅으로 가져왔어요');
    const imported = await (await request.get(`/api/chats/${result.chat.id}`)).json();
    expect(imported.sources.map((item: { text: string }) => item.text)).toEqual(['원본 장면']);
    // The backup branch uses its unchanged restore request, never the preselected bot.
    await dialog.getByRole('button', { name: '가져오기 방식 변경' }).click();
    await dialog.getByRole('button', { name: /채팅 백업 복원/ }).click();
    const backupRequests: unknown[] = [];
    await page.route('**/api/chats/import-backup', async (route) => {
      backupRequests.push(route.request().postDataJSON());
      if (backupRequests.length === 1) {
        const committed = await route.fetch();
        expect(committed.ok(), await committed.text()).toBe(true);
        const first = await committed.json();
        expect(first.created).toBe(true);
        expect(first.chat.botId).toBe(original.bot.id);
        await route.abort('failed');
      } else await route.continue();
    });
    const backup = await (await request.get(`/api/chats/${original.chat.id}/backup`)).json();
    await dialog.getByLabel('채팅 백업 파일 선택').setInputFiles({
      name: 'original.uimori-chat.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(backup)),
    });
    expect(backupRequests).toHaveLength(0);
    await dialog.getByRole('button', { name: '새 채팅으로 가져오기', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '같은 요청 확인', exact: true })).toBeEnabled();
    await expect(dialog.getByLabel('채팅 백업 파일 선택')).toBeDisabled();
    await expect(dialog.getByRole('button', { name: '선택 취소', exact: true })).toBeDisabled();
    await expect(
      dialog.getByRole('button', { name: '가져오기 방식 변경', exact: true })
    ).toBeDisabled();
    await expect(dialog.getByRole('button', { name: '닫기', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    const backupEvent = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/chats/import-backup') &&
        response.request().method() === 'POST' &&
        response.status() === 200
    );
    await dialog.getByRole('button', { name: '같은 요청 확인', exact: true }).click();
    const restored = await (await backupEvent).json();
    expect(restored.created).toBe(false);
    expect(restored.chat.botId).toBe(original.bot.id);
    expect(backupRequests).toHaveLength(2);
    expect(backupRequests[1]).toEqual(backupRequests[0]);
    await expect(dialog.getByRole('status')).toContainText('복원했어요');
    await expect(dialog.getByRole('button', { name: '닫기', exact: true })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
}
