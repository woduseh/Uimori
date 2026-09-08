import { visualReview } from './fixtures/visual-review.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { test, expect } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import { navigationAction } from './ui-navigation.js';
import type { PromptWorkspace } from '../core/product.js';

test('PWS01 current options apply globally without changing chat profiles', async ({
  page,
  request,
}, info) => {
  const before = (await (await request.get('/api/prompt-workspace')).json()) as PromptWorkspace;
  const updated = await request.put('/api/prompt-workspace', {
    data: {
      expectedRevision: before.revision,
      main: {
        title: '합성 현재 작문',
        program: {
          version: 1,
          controls: [{ id: 'tone', label: '합성 문체', type: 'text', default: '담백하게' }],
          blocks: [{ id: 'history', kind: 'history', title: 'History', from: 0, to: 'end' }],
        },
        values: {},
      },
    },
  });
  expect(updated.ok()).toBe(true);
  const chat = await (
    await postFixtureChat(request, { data: { title: '현재 프롬프트 확인' } })
  ).json();
  const profile = (await (await request.get(`/api/chats/${chat.id}`)).json()).profile;
  await page.goto(`/?chat=${chat.id}`);
  await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
  await page.getByRole('button', { name: '창작 옵션', exact: true }).click();
  const panel = page.getByRole('region', { name: '창작 옵션 패널' });
  await panel.getByLabel('합성 문체', { exact: true }).fill('간결하게');
  await panel.getByRole('button', { name: '현재 옵션 적용', exact: true }).click();
  await expect(panel.getByRole('button', { name: '현재 옵션 적용' })).toBeDisabled();
  expect((await (await request.get('/api/prompt-workspace')).json()).main.values.tone).toBe(
    '간결하게'
  );
  expect((await (await request.get(`/api/chats/${chat.id}`)).json()).profile).toEqual(profile);
  if (visualReview)
    await page.screenshot({ path: info.outputPath('prompt-workspace-options.png') });
  await panel.getByRole('button', { name: '창작 옵션 닫기' }).click();
  const other = await (
    await postFixtureChat(request, { data: { title: '다른 채팅 현재 옵션' } })
  ).json();
  await page.goto(`/?chat=${other.id}`);
  await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
  await page.getByRole('button', { name: '창작 옵션', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '창작 옵션 패널' }).getByLabel('합성 문체', { exact: true })
  ).toHaveValue('간결하게');
});

test('PWS02 translation policy and prompt options save in the independent workspace', async ({
  page,
  request,
}, info) => {
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  await page.getByText('현재 작문·번역 프롬프트 설정', { exact: true }).click();
  const editor = page.getByRole('region', { name: '현재 프롬프트 설정' });
  await editor.getByLabel('현재 프롬프트 역할').selectOption('translation');
  await editor.getByLabel('번역 자동 재요청 횟수').fill('2');
  await editor.getByLabel('번역 전체 호출 한도').fill('12');
  await editor.getByRole('button', { name: '현재 설정 저장', exact: true }).click();
  await expect(
    editor.getByText('현재 프롬프트와 옵션을 저장했어요.', { exact: true })
  ).toBeVisible();
  const workspace = await (await request.get('/api/prompt-workspace')).json();
  expect(workspace.translationPolicy).toMatchObject({ maxRetries: 2, maxCalls: 12 });
  if (visualReview)
    await page.screenshot({ path: info.outputPath('prompt-workspace-translation.png') });
});

preservePromptWorkspace();
