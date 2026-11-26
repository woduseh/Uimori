import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Content } from '../core/product.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { openChatSettings, selectChatSettingsSection } from './ui-navigation.js';

async function fixture(request: APIRequestContext) {
  const input = fixtureBotInput(`Chat recovery ${randomUUID()}`);
  input.package.nativeRisu.card.extensions = {
    risuai: { defaultVariables: 'trust=40\nlocation=reading_room\nempty=' },
  };
  const created = await request.post('/api/content', { data: input });
  expect(created.ok(), await created.text()).toBe(true);
  const bot = (await created.json()) as Content;
  const response = await request.post('/api/chats', { data: { title: bot.title, botId: bot.id } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<{ id: string }>;
}

async function open(page: Page, chatId: string) {
  await page.goto(`/?chat=${chatId}`);
  await expect(page.getByLabel('다음 장면 요청', { exact: true })).toBeVisible();
  await openChatSettings(page);
  return page.getByRole('dialog', { name: '채팅 설정', exact: true });
}

test('CHATREC02 variable rows preserve empty strings, raw drafts, conflicts and uncertain save receipts', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  const chat = await fixture(request);
  const endpoint = `/api/chats/${chat.id}/variables`;
  let dialog = await open(page, chat.id);
  await selectChatSettingsSection(page, '채팅 변수');
  const value = (key: string) => dialog.getByLabel(`${key} 문자열 값`, { exact: true });
  await expect(value('trust')).toHaveValue('40');
  await value('trust').fill('');
  await value('location').fill('garden');
  await dialog.getByLabel('location 재정의 해제', { exact: true }).click();
  await expect(value('location')).toHaveValue('reading_room');
  await dialog.getByRole('button', { name: 'JSON 편집', exact: true }).click();
  const raw = dialog.getByLabel('채팅 변수 재정의 (JSON)', { exact: true });
  expect(JSON.parse(await raw.inputValue())).toEqual({ trust: '' });
  await raw.fill('{"trust":');
  await selectChatSettingsSection(page, '기억과 메모');
  await selectChatSettingsSection(page, '채팅 변수');
  await expect(raw).toHaveValue('{"trust":');
  await expect(dialog.getByRole('button', { name: '행 편집', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
  await page.reload();
  await openChatSettings(page);
  dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
  await selectChatSettingsSection(page, '채팅 변수');
  await expect(raw).toHaveValue('{"trust":');
  await raw.fill('{"trust":""}');
  await dialog.getByRole('button', { name: '행 편집', exact: true }).click();
  await expect(value('trust')).toHaveValue('');
  const initial = await (await request.get(endpoint)).json();
  const concurrent = await request.put(endpoint, {
    data: {
      expectedRevision: initial.revision,
      expectedSourceHash: initial.sourceHash,
      idempotencyKey: randomUUID(),
      values: { trust: 'concurrent' },
    },
  });
  expect(concurrent.ok(), await concurrent.text()).toBe(true);
  await selectChatSettingsSection(page, '사용 자료');
  await selectChatSettingsSection(page, '채팅 변수');
  await expect(
    dialog.getByText('변수 저장본이나 현재 원문이 바뀌었어요.', { exact: true })
  ).toBeVisible();
  await expect(value('trust')).toHaveValue('');
  await dialog.getByRole('button', { name: '입력값 유지하고 계속 편집', exact: true }).click();
  const bodies: unknown[] = [];
  let loseResponse = true;
  let holdReads = false;
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let readStarted = false;
  try {
    await page.route(`**${endpoint}`, async (route) => {
      if (route.request().method() === 'GET' && holdReads) {
        const observed = await route.fetch();
        readStarted = true;
        await readGate;
        return route.fulfill({ response: observed });
      }
      if (route.request().method() !== 'PUT') return route.continue();
      bodies.push(route.request().postDataJSON());
      if (!loseResponse) return route.continue();
      loseResponse = false;
      const persisted = await route.fetch();
      expect(persisted.ok()).toBe(true);
      await route.fulfill({
        status: 503,
        json: { error: 'Synthetic lost response after commit' },
      });
    });
    const save = dialog.getByRole('button', { name: '채팅 변수 저장', exact: true });
    const saveElement = await save.elementHandle();
    expect(saveElement).not.toBeNull();
    await save.click();
    const confirm = dialog.getByRole('button', { name: '저장 결과 확인', exact: true });
    await expect(confirm).toBeEnabled();
    await expect(value('trust')).toBeDisabled();
    expect(
      await saveElement!.evaluate(
        (element) => element.isConnected && element.getAttribute('aria-label') === '저장 결과 확인'
      )
    ).toBe(true);
    await confirm.focus();
    await expect(confirm).toBeFocused();
    await expect(dialog.locator('.chat-variable-readbacks pre').first()).toContainText(
      '"trust": ""'
    );
    holdReads = true;
    await selectChatSettingsSection(page, '사용 자료');
    await selectChatSettingsSection(page, '채팅 변수');
    await expect.poll(() => readStarted).toBe(true);
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: '채팅 변수를 저장했어요. 다음 생성부터 적용해요.' })
    ).toBeVisible();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    const final = await (await request.get(endpoint)).json();
    expect(final.values).toEqual({ trust: '' });
    expect(final.resolved.location).toBe('reading_room');
    await expect(value('trust')).toBeEnabled();
    await value('trust').fill('확인 뒤 새 초안');
    const lateRead = page.waitForResponse(
      (response) => response.url().endsWith(endpoint) && response.request().method() === 'GET'
    );
    holdReads = false;
    releaseRead();
    await (await lateRead).finished();
    await expect(value('trust')).toHaveValue('확인 뒤 새 초안');
    await expect(dialog.getByRole('button', { name: '채팅 변수 저장', exact: true })).toBeEnabled();
    expect((await (await request.get(endpoint)).json()).values).toEqual({ trust: '' });
  } finally {
    releaseRead();
  }
});
