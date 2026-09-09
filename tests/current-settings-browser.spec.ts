import { visualReview } from './fixtures/visual-review.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { fixtureBotInput } from './fixtures/chat.js';
import type { ChatDetail } from '../core/types.js';
import type { Library, PromptPreset } from '../core/product.js';
import type { PromptProgram } from '../core/prompt-program.js';
import { navigationAction, openNewStoryOptions } from './ui-navigation.js';

async function detail(request: APIRequestContext, chatId: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${chatId}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

test('CURRENTUI01 changed control definitions exclude old combinations and reject direct application', async ({
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
  const originalWorkspace = await (await request.get('/api/prompt-workspace')).json();
  expect(
    (
      await request.post('/api/prompt-workspace/apply', {
        data: { expectedRevision: originalWorkspace.revision, role: 'main', presetId: prompt.id },
      })
    ).ok()
  ).toBe(true);
  const combinationResponse = await request.post('/api/prompt-combinations', {
    data: {
      title: '보존한 창작 조합',
      role: 'main',
      values: { detail: 3, style: 'old', removed: true },
      owner: { kind: 'preset', id: prompt.id },
      expectedRevision: prompt.revision,
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
  await updatedResponse.json();
  const copiedBefore = await (await request.get('/api/prompt-workspace')).json();
  expect(copiedBefore.main.program).toEqual(program);
  expect(
    (
      await request.post('/api/prompt-workspace/apply', {
        data: { expectedRevision: copiedBefore.revision, role: 'main', presetId: prompt.id },
      })
    ).ok()
  ).toBe(true);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?chat=${chat.id}`);
  await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
  await page.getByRole('button', { name: '창작 옵션', exact: true }).click();
  const panel = page.getByRole('region', { name: '창작 옵션 패널', exact: true });
  await expect(panel.getByRole('option', { name: '보존한 창작 조합', exact: true })).toHaveCount(0);
  const currentWorkspace = await (await request.get('/api/prompt-workspace')).json();
  expect(currentWorkspace.main.presetId).toBe(prompt.id);
  const rejected = await request.post('/api/prompt-workspace/apply-options', {
    data: {
      expectedRevision: currentWorkspace.revision,
      role: 'main',
      combinationId: combination.id,
    },
  });
  expect(rejected.status()).toBe(409);
  expect(await (await request.get('/api/prompt-workspace')).json()).toEqual(currentWorkspace);
  const library = (await (await request.get('/api/library')).json()) as Library;
  expect(library.promptCombinations?.find((item) => item.id === combination.id)).toEqual(
    combination
  );
  await expect(panel.getByLabel('합성 서술량', { exact: true })).toHaveValue('1');
  await expect(panel.getByLabel('합성 문체', { exact: true })).toHaveValue(
    JSON.stringify('current')
  );
  await expect(panel.getByLabel('새 합성 옵션', { exact: true })).not.toBeChecked();
  await expect(panel.getByLabel('제거할 옵션', { exact: true })).toHaveCount(0);
  await panel.getByLabel('합성 서술량', { exact: true }).fill('3');
  await panel.getByRole('button', { name: '현재 옵션 적용', exact: true }).click();
  await expect
    .poll(async () => (await (await request.get('/api/prompt-workspace')).json()).main.values)
    .toEqual({ detail: 3, style: 'current', added: false });
  if (visualReview)
    await page.screenshot({ path: info.outputPath('current-prompt-options-mobile.png') });
  await panel.getByRole('button', { name: '창작 옵션 닫기', exact: true }).click();
  const savedWorkspace = await (await request.get('/api/prompt-workspace')).json();
  const owner = await (await request.get(`/api/content/${chat.botId}`)).json();
  await navigationAction(page, '새 채팅', owner.title);
  const newChat = page.getByRole('dialog', { name: '새 채팅', exact: true });
  await openNewStoryOptions(page);
  await expect(newChat.getByLabel('시작 프롬프트', { exact: true })).toHaveCount(0);
  await expect(newChat.getByLabel('시작 옵션 조합', { exact: true })).toHaveCount(0);
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/chats' && response.request().method() === 'POST'
  );
  await newChat.getByRole('button', { name: '채팅 만들기', exact: true }).click();
  const accepted = await created;
  expect(accepted.ok()).toBe(true);
  const newChatData = await accepted.json();
  await expect(newChat).not.toBeVisible();
  expect((await detail(request, newChatData.id)).profile).not.toHaveProperty('promptControls');
  expect(await (await request.get('/api/prompt-workspace')).json()).toEqual(savedWorkspace);
  expect(errors).toEqual([]);
});

preservePromptWorkspace();
