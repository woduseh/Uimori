import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { fixtureBotInput } from './fixtures/chat.js';
import { nativeContent } from './fixtures/native-content.js';
import { navigationAction, selectSettingsSection, visibleNavigation } from './ui-navigation.js';

async function createChat(request: APIRequestContext, title: string) {
  const botTitle = title + randomUUID();
  const input = fixtureBotInput(botTitle);
  input.package = nativeContent({ name: botTitle, first_mes: '합성 첫 메시지' });
  const botResponse = await request.post('/api/content', { data: input });
  expect(botResponse.ok()).toBe(true);
  const bot = await botResponse.json();
  const response = await request.post('/api/chats', { data: { title, botId: bot.id } });
  expect(response.ok()).toBe(true);
  return { chat: await response.json(), bot };
}
async function saveClose(page: Page) {
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  const guard = page.getByRole('alertdialog', { name: '미저장 설정 확인', exact: true });
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
  return guard;
}
async function generate(page: Page, text: string) {
  await page.getByRole('textbox', { name: '다음 장면 요청' }).fill(text);
  await page.getByRole('button', { name: '원문 생성', exact: true }).click();
  await expect(page.getByRole('button', { name: '원문 생성 취소', exact: true })).toBeVisible();
}
async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(name + '.png') });
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/agent-runtimes/codex', (route) =>
    route.fulfill({
      json: {
        available: false,
        authenticated: false,
        authMode: null,
        limits: [],
        error: 'CODEX_DISABLED',
      },
    })
  );
});

for (const width of [390, 1440]) {
  test(`INTREG01 new-chat model detour restores draft and explicit new flow resets ${width}`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { chat, bot } = await createChat(request, 'New draft detour');
    await page.goto('/?chat=' + chat.id);
    await navigationAction(page, '새 채팅', bot.title);
    const dialog = page.getByRole('dialog', { name: '새 채팅', exact: true });
    await dialog.locator('.new-story-options summary').click();
    const title = dialog.getByLabel('새 채팅 이름', { exact: true });
    await title.fill('설정을 다녀와도 남길 제목');
    const opening = dialog.getByLabel('첫 메시지 선택', { exact: true });
    await opening.selectOption('');
    for (const dismissal of ['close', 'back']) {
      await dialog.getByRole('button', { name: '전역 모델 설정', exact: true }).click();
      const settings = page.getByRole('dialog', { name: '설정', exact: true });
      await expect(settings.locator('.app-settings-panel')).toBeVisible();
      if (dismissal === 'close')
        await settings.getByRole('button', { name: '설정 닫기', exact: true }).click();
      else {
        // Narrow settings Back first returns to the section list.
        await page.goBack();
        if (await settings.isVisible()) await page.goBack();
      }
      await expect(dialog).toBeVisible();
      await expect(title).toHaveValue('설정을 다녀와도 남길 제목');
      await expect(opening).toHaveValue('');
    }
    await screenshot(page, 'new-chat-restored');
    await dialog.getByRole('button', { name: '새 채팅 닫기', exact: true }).click();
    await navigationAction(page, '새 채팅', bot.title);
    await dialog.locator('.new-story-options summary').click();
    await expect(title).toHaveValue('');
  });

  test(`INTREG02 backup save-close validates, retains failures and saves once ${width}`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '데이터 관리');
    const count = page.getByLabel('성공본 보관 개수', { exact: true });
    await expect(count).toBeVisible();
    const original = (await (await request.get('/api/backups')).json()).settings.retain;
    const next = original === 7 ? 8 : 7;
    let calls = 0;
    let fail = true;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/backups/settings', async (route) => {
      calls++;
      if (fail) await route.fulfill({ status: 503, json: { error: 'Synthetic backup failure' } });
      else {
        await held;
        await route.fulfill({ response: await route.fetch() });
      }
    });
    await count.fill('0');
    let guard = await saveClose(page);
    await expect(guard).toBeVisible();
    await expect(guard.getByRole('button', { name: '계속 편집', exact: true })).toBeEnabled();
    expect(calls).toBe(0);
    await guard.getByRole('button', { name: '계속 편집', exact: true }).click();
    await count.fill(String(next));
    guard = await saveClose(page);
    await expect(guard.getByRole('alert')).toBeVisible();
    await expect(guard.getByRole('alert')).not.toContainText('가져오기 파일');
    await guard.getByRole('button', { name: '계속 편집', exact: true }).click();
    await expect(count).toHaveValue(String(next));
    expect((await (await request.get('/api/backups')).json()).settings.retain).toBe(original);
    fail = false;
    guard = await saveClose(page);
    await expect.poll(() => calls).toBe(2);
    await expect(guard.getByRole('button', { name: '저장 중…', exact: true })).toBeDisabled();
    await screenshot(page, 'backup-save-pending');
    release();
    await expect(page.getByRole('dialog', { name: '설정', exact: true })).toBeHidden();
    expect((await (await request.get('/api/backups')).json()).settings.retain).toBe(next);
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '데이터 관리');
    await expect(count).toHaveValue(String(next));
    await screenshot(page, 'backup-saved');
  });

  test(`INTREG03 pending cancellation locks repeated clicks and retains request ${width}`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { chat } = await createChat(request, 'Pending cancel');
    await request.post('/api/test/control', { data: { action: 'hold', barrier: 'run' } });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    await page.route('**/api/runs/*/cancel', async (route) => {
      calls++;
      await held;
      await route.fulfill({ response: await route.fetch() });
    });
    try {
      await page.goto('/?chat=' + chat.id);
      await generate(page, '취소 후에도 보존할 원래 요청');
      const cancel = page.getByRole('button', { name: /^원문 생성 취소/ });
      await cancel.evaluate((node: HTMLButtonElement) => {
        node.click();
        node.click();
        node.click();
      });
      await expect.poll(() => calls).toBe(1);
      await expect(cancel).toBeDisabled();
      await expect(cancel).toHaveAttribute('aria-label', '원문 생성 취소 중');
      await expect(page.locator('.composer-status')).toContainText('원문 생성 취소 중');
      await screenshot(page, 'cancel-pending');
      release();
      await expect(page.getByRole('button', { name: '원문 생성', exact: true })).toBeVisible();
      expect(calls).toBe(1);
      await expect(
        page.getByText('취소 후에도 보존할 원래 요청', { exact: true }).first()
      ).toBeVisible();
    } finally {
      release();
      await request.post('/api/test/control', { data: { action: 'release', barrier: 'run' } });
    }
  });

  test(`INTREG04 cancellation error stays with initiating navigation and unlocks retry ${width}`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { chat } = await createChat(request, 'Cancel origin');
    const second = await (
      await request.post('/api/chats', {
        data: { title: 'Cancel destination ' + randomUUID(), botId: chat.botId },
      })
    ).json();
    await request.post('/api/test/control', { data: { action: 'hold', barrier: 'run' } });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    await page.route('**/api/runs/*/cancel', async (route) => {
      calls++;
      if (calls === 1) await held;
      if (calls <= 2)
        await route.fulfill({ status: 503, json: { error: 'Synthetic cancel failed' } });
      else await route.fulfill({ response: await route.fetch() });
    });
    try {
      await page.goto('/?chat=' + chat.id);
      await generate(page, 'A cancellation request');
      await page.getByRole('button', { name: '원문 생성 취소', exact: true }).click();
      await expect.poll(() => calls).toBe(1);
      let nav = await visibleNavigation(page);
      await nav.getByRole('button', { name: second.title, exact: true }).click();
      await expect(page.locator('.header-title h1')).toHaveText(second.title);
      release();
      // A's request has completed, but cannot write an alert into B.
      await expect
        .poll(() => page.getByRole('button', { name: '원문 생성', exact: true }).count())
        .toBe(1);
      await expect(
        page.getByRole('alert').filter({ hasText: '서버 작업을 완료하지 못했어요. (503)' })
      ).toHaveCount(0);
      await screenshot(page, 'cancel-error-not-in-destination');
      nav = await visibleNavigation(page);
      await nav.getByRole('button', { name: chat.title, exact: true }).click();
      const cancel = page.getByRole('button', { name: '원문 생성 취소', exact: true });
      await expect(cancel).toBeEnabled();
      await cancel.click();
      await expect(
        page.getByRole('alert').filter({ hasText: '서버 작업을 완료하지 못했어요. (503)' })
      ).toBeVisible();
      await expect(cancel).toBeEnabled();
      await screenshot(page, 'cancel-failure-retry');
      await cancel.click();
      await expect(page.getByRole('button', { name: '원문 생성', exact: true })).toBeVisible();
      expect(calls).toBe(3);
    } finally {
      release();
      await request.post('/api/test/control', { data: { action: 'release', barrier: 'run' } });
    }
  });
}
