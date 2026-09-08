import { test, expect, type APIRequestContext } from '@playwright/test';
import { fixtureBotInput } from './fixtures/chat.js';
import type { ChatDetail } from '../core/types.js';
import type { PromptPreset } from '../core/product.js';
import type { PromptProgram } from '../core/prompt-program.js';
import { navigationAction, openNewStoryOptions } from './ui-navigation.js';

async function detail(request: APIRequestContext, chatId: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${chatId}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

test('CURRENTUI01 saved creative combinations follow current prompt controls without revision choices', async ({
  page,
  request,
}, info) => {
  const program: PromptProgram = {
    version: 1,
    controls: [
      { id: 'detail', label: '합성 서술량', type: 'number', min: 0, max: 5, default: 1 },
      {
        id: 'style',
        label: '합성 문체',
        type: 'select',
        default: 'old',
        options: [{ label: '이전 문체', value: 'old' }],
      },
      { id: 'removed', label: '제거할 옵션', type: 'boolean', default: false },
    ],
    blocks: [
      {
        id: 'instructions',
        title: '합성 지침',
        kind: 'message',
        role: 'system',
        template: [{ kind: 'text', text: 'Synthetic current settings.' }],
      },
      { id: 'history', title: 'History', kind: 'history', from: 0, to: 'end' },
    ],
  };
  const response = await request.post('/api/prompt-presets', {
    data: { title: `현재 프롬프트 ${Date.now()}`, role: 'main', program },
  });
  expect(response.ok()).toBe(true);
  const prompt = (await response.json()) as PromptPreset;
  const combinationResponse = await request.post('/api/prompt-combinations', {
    data: {
      title: '보존한 창작 조합',
      prompt: { id: prompt.id, revision: prompt.revision },
      values: { detail: 3, style: 'old', removed: true },
    },
  });
  expect(combinationResponse.ok()).toBe(true);
  const combination = await combinationResponse.json();
  const botResponse = await request.post('/api/content', {
    data: fixtureBotInput(`현재 옵션 합성 봇 ${Date.now()}`),
  });
  expect(botResponse.ok()).toBe(true);
  const bot = await botResponse.json();
  const chatResponse = await request.post('/api/chats', {
    data: { title: '현재 옵션 합성 채팅', botId: bot.id },
  });
  expect(chatResponse.ok()).toBe(true);
  const chat = await chatResponse.json();
  const profile = (await detail(request, chat.id)).profile!;
  expect(
    (
      await request.put(`/api/chats/${chat.id}/profile`, {
        data: {
          ...profile,
          chatId: undefined,
          revision: undefined,
          expectedRevision: profile.revision,
          prompts: { main: { id: prompt.id, revision: prompt.revision } },
        },
      })
    ).ok()
  ).toBe(true);
  const updatedResponse = await request.put(`/api/prompt-presets/${prompt.id}`, {
    data: {
      title: prompt.title,
      role: 'main',
      expectedRevision: prompt.revision,
      program: {
        ...program,
        controls: [
          program.controls[0],
          {
            id: 'style',
            label: '합성 문체',
            type: 'select',
            default: 'current',
            options: [{ label: '현재 문체', value: 'current' }],
          },
          { id: 'added', label: '새 합성 옵션', type: 'boolean', default: false },
        ],
      },
    },
  });
  expect(updatedResponse.ok()).toBe(true);
  const updated = (await updatedResponse.json()) as PromptPreset;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?chat=${chat.id}`);
  await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
  await page.getByRole('button', { name: '창작 옵션', exact: true }).click();
  const panel = page.getByRole('region', { name: '창작 옵션 패널', exact: true });
  await panel.getByLabel('창작 옵션 프리셋', { exact: true }).selectOption(combination.id);
  await expect(panel.getByLabel('합성 서술량', { exact: true })).toHaveValue('3');
  await expect(panel.getByLabel('합성 문체', { exact: true })).toHaveValue(
    JSON.stringify('current')
  );
  await expect(panel.getByLabel('새 합성 옵션', { exact: true })).not.toBeChecked();
  await expect(panel.getByLabel('제거할 옵션', { exact: true })).toHaveCount(0);
  await expect(panel).toContainText('현재 옵션과 맞지 않는 이전 선택값은 기본값으로 조정했어요.');
  await panel.getByRole('button', { name: '이 채팅에 적용', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await detail(request, chat.id)).profile?.promptControls?.[
          `${updated.id}@${updated.revision}`
        ]?.values
    )
    .toEqual({ detail: 3, style: 'current', added: false });
  await page.screenshot({ path: info.outputPath('current-prompt-options-mobile.png') });
  await panel.getByRole('button', { name: '창작 옵션 닫기', exact: true }).click();
  await page.getByRole('button', { name: '채팅 설정', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '채팅 설정', exact: true });
  await settings.getByRole('tab', { name: '프롬프트·창작 프리셋', exact: true }).click();
  const editor = settings.getByTestId('prompt-editor');
  const options = editor.getByLabel('불러올 프롬프트', { exact: true }).locator('option');
  await expect(options.filter({ hasText: prompt.title })).toHaveCount(1);
  await expect(options.filter({ hasText: prompt.title })).toHaveText(prompt.title);
  await editor.getByLabel('전역 창작 조합', { exact: true }).selectOption(combination.id);
  await expect(editor.getByLabel('합성 서술량', { exact: true })).toHaveValue('3');
  await expect(editor.getByLabel('합성 문체', { exact: true })).toHaveValue(
    JSON.stringify('current')
  );
  await expect(editor).toContainText('현재 옵션과 맞지 않는 이전 선택값은 기본값으로 조정했어요.');
  expect(await settings.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.keyboard.press('Escape');
  const ownerResponse = await request.get(`/api/content/${chat.botId}`);
  expect(ownerResponse.ok()).toBe(true);
  const owner = await ownerResponse.json();
  await navigationAction(page, '새 채팅', owner.title);
  const newChat = page.getByRole('dialog', { name: '새 채팅', exact: true });
  await openNewStoryOptions(page);
  await newChat
    .getByLabel('시작 프롬프트', { exact: true })
    .selectOption(`${updated.id}@${updated.revision}`);
  await newChat
    .getByLabel('시작 옵션 조합', { exact: true })
    .selectOption(`${combination.id}@${combination.revision}`);
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/chats' && response.request().method() === 'POST'
  );
  await newChat.getByRole('button', { name: '채팅 만들기', exact: true }).click();
  const accepted = await created;
  expect(accepted.ok()).toBe(true);
  const newChatData = await accepted.json();
  await expect(newChat).not.toBeVisible();
  expect(
    (await detail(request, newChatData.id)).profile?.promptControls?.[
      `${updated.id}@${updated.revision}`
    ]?.values
  ).toEqual({ detail: 3, style: 'current', added: false });
  expect(errors).toEqual([]);
});
