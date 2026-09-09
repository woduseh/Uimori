import { visualReview } from './fixtures/visual-review.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { test, expect } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import { navigationAction, selectSettingsSection } from './ui-navigation.js';
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
  await page.getByRole('tab', { name: '모든 채팅', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: '모든 채팅 옵션', exact: true });
  await panel.getByLabel('합성 문체', { exact: true }).fill('간결하게');
  await panel.getByRole('button', { name: '현재 옵션 적용', exact: true }).click();
  await expect(panel.getByRole('button', { name: '현재 옵션 적용' })).toBeDisabled();
  expect((await (await request.get('/api/prompt-workspace')).json()).main.values.tone).toBe(
    '간결하게'
  );
  expect((await (await request.get(`/api/chats/${chat.id}`)).json()).profile).toEqual(profile);
  if (visualReview)
    await page.screenshot({ path: info.outputPath('prompt-workspace-options.png') });
  await page.getByRole('button', { name: '창작 옵션 닫기' }).click();
  const other = await (
    await postFixtureChat(request, { data: { title: '다른 채팅 현재 옵션' } })
  ).json();
  await page.goto(`/?chat=${other.id}`);
  await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
  await page.getByRole('button', { name: '창작 옵션', exact: true }).click();
  await page.getByRole('tab', { name: '모든 채팅', exact: true }).click();
  await expect(
    page.getByRole('tabpanel', { name: '모든 채팅 옵션' }).getByLabel('합성 문체', { exact: true })
  ).toHaveValue('간결하게');
});

test('PWS02 translation policy and prompt options save in the independent workspace', async ({
  page,
  request,
}, info) => {
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '현재 모델');
  const models = page.getByRole('region', { name: '현재 모델 설정' });
  const details = models.locator('details').filter({ hasText: '거절 감지' });
  await details.locator('summary').click();
  await models.getByLabel('번역 자동 재요청 횟수').fill('2');
  await models.getByLabel('번역 전체 호출 한도').fill('12');
  await models.getByRole('button', { name: '현재 모델 설정 저장', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/model-workspace')).json()).translationPolicy.maxCalls
    )
    .toBe(12);
  const editor = page.getByRole('region', { name: '현재 프롬프트 설정' });
  const workspace = await (await request.get('/api/prompt-workspace')).json();
  expect(workspace.translationPolicy).toMatchObject({ maxRetries: 2, maxCalls: 12 });
  // Switching to either a new or stored library preset must protect the current workspace draft.
  const created = await request.post('/api/prompt-presets', {
    data: {
      title: `PWS draft guard ${crypto.randomUUID()}`,
      role: 'translation',
      program: workspace.translation.program,
    },
  });
  expect(created.ok()).toBe(true);
  const preset = await created.json();
  await page.reload();
  await navigationAction(page, '프롬프트');
  await page.getByText('현재 작문·번역 프롬프트 설정', { exact: true }).click();
  await editor.getByLabel('현재 프롬프트 역할').selectOption('translation');
  await editor.getByLabel('현재 프롬프트 이름').fill('PWS unsaved translation');
  const library = page.getByTestId('prompt-library');
  const guard = page.getByRole('alertdialog', { name: '미저장 프롬프트 확인', exact: true });
  await library.getByRole('button', { name: '새 프롬프트', exact: true }).first().click();
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expect(editor.getByLabel('현재 프롬프트 이름')).toHaveValue('PWS unsaved translation');
  await library.getByRole('button', { name: `${preset.title} 프롬프트 편집`, exact: true }).click();
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: '초안 버리고 이동', exact: true }).click();
  await expect(
    page.getByTestId('prompt-editor').getByLabel('프롬프트 이름', { exact: true })
  ).toHaveValue(preset.title);
  expect(await (await request.get('/api/prompt-workspace')).json()).toEqual(workspace);

  if (visualReview)
    await page.screenshot({ path: info.outputPath('prompt-workspace-translation.png') });
});

test('PWS03 pristine workspace drafts adopt newer settings while edited drafts retain their conflict', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '현재 프롬프트');
  const editor = page.getByRole('region', { name: '현재 프롬프트 설정' });
  const title = editor.getByLabel('현재 프롬프트 이름', { exact: true });
  await expect(title).toBeVisible();
  const current = (await (await request.get('/api/prompt-workspace')).json()) as PromptWorkspace;
  const updated = await request.put('/api/prompt-workspace', {
    data: {
      expectedRevision: current.revision,
      main: { ...current.main, title: 'PWS03 another tab saved' },
    },
  });
  expect(updated.ok(), await updated.text()).toBe(true);
  const saved = (await updated.json()) as PromptWorkspace;
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await expect(title).toHaveValue(saved.main.title);
  await expect(editor.getByLabel('현재 프롬프트 프리셋', { exact: true })).toBeEnabled();
  await expect(editor.getByRole('button', { name: '현재 설정 저장', exact: true })).toBeDisabled();
  expect((await (await request.get('/api/prompt-workspace')).json()).revision).toBe(saved.revision);

  await title.fill('PWS03 my unsaved input');
  await expect
    .poll(async () => {
      const drafts = await (
        await request.get('/api/edit-drafts?editorKey=prompt-workspace%3Acurrent')
      ).json();
      return drafts[0]?.model.main.title;
    })
    .toBe('PWS03 my unsaved input');
  const changed = await request.put('/api/prompt-workspace', {
    data: {
      expectedRevision: saved.revision,
      main: { ...saved.main, title: 'PWS03 newer external title' },
    },
  });
  expect(changed.ok(), await changed.text()).toBe(true);
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await expect(title).toHaveValue('PWS03 my unsaved input');
  await expect(editor.getByRole('alert')).toContainText('다른 곳에서 현재 프롬프트가 바뀌었어요.');
  await expect(editor.getByRole('button', { name: '현재 설정 저장', exact: true })).toBeDisabled();
  expect((await (await request.get('/api/prompt-workspace')).json()).main.title).toBe(
    'PWS03 newer external title'
  );
  await page.reload();
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '현재 프롬프트');
  await expect(title).toHaveValue('PWS03 my unsaved input');
});

preservePromptWorkspace();
